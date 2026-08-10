import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { peakSince } from '../pipeline/history';
import { aggregate, type DexPair, type TokenView } from '../pipeline/dexscreener';
import { chainFromSlug } from '../parse/chains';
import type { Chain, RiskLevel, Signal } from '../types';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/tracked.json');

/** DexScreener accepts up to 30 comma-separated addresses per request. */
const BATCH = 30;

/** After a day the outcome is decided; polling longer just burns quota. */
const RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Below this, the pool is gone in any practical sense. */
const RUG_LIQUIDITY_USD = 500;

/**
 * How far a sampled peak may sit above the chart before we stop believing our own sample.
 *
 * Two live pools of one token are dragged together by anyone willing to arbitrage them, so they
 * disagree by percent, not by multiples. Ten times apart is not two honest quotes — it is one
 * of them being wrong, and the sampled side is the one with no candles behind it. See `settle`.
 *
 * Exported so `npm run audit` applies the same rule to rows already written. A row poisoned
 * before this existed cannot fix itself: the peak only ever climbed, so the fiction outlived
 * the bug. One threshold, or the audit and the tracker disagree about what a bad number is.
 */
export const CONTRADICTED = 10;

export type Outcome =
  | 'called'
  | 'staged'
  | 'shadow'
  | 'dry-run'
  | 'duplicate'
  /** Somebody paid for the slot. Tracked so it can be answered for, never counted as ours. */
  | 'promo'
  /** A channel member's own pick, for the competition. Measured, never published. */
  | 'member';

/**
 * Which outcome wins when the same source calls the same coin twice. Higher takes precedence.
 *
 * There are two regions here, and the boundary matters more than the order inside them.
 * `duplicate` through `called` is **ours, and it can climb**: a call normally arrives as
 * `staged` and is promoted to `called` when somebody approves it.
 *
 * `promo` and `member` sit *above* `called` — not because a bought slot outranks a call, but
 * because putting them above the top of the climbing region makes them **sticky**. No later
 * code path can promote a paid advert or a stranger's pick into a call of ours, however it is
 * routed. Each also carries its own `sourceId`, so its record can never merge with a coin we
 * called ourselves. `isPublished` asks for `called`, and neither of these can ever become it:
 * that is what keeps both off the scoreboard, out of the X feed and out of the milestone
 * replies, without anyone having to remember to check.
 */
const RANK: Record<Outcome, number> = {
  duplicate: 0,
  shadow: 1,
  'dry-run': 2,
  staged: 3,
  called: 4,
  promo: 5,
  member: 6,
};

export interface TrackedCall {
  id: string;
  sourceId: string;
  outcome: Outcome;
  chain: Chain;
  address: string;
  ticker?: string;
  name?: string;
  calledAt: number;
  /** What the screen said when this arrived, not what it would say now. */
  risk?: RiskLevel;
  riskFlags?: string[];
  /** We looked at this and said no. Strictly narrower than `staged`, which only means it
   *  reached the war room — and usually nobody was there. See `decline`. */
  declined?: boolean;
  declinedReason?: string;
  entryPriceUsd?: number;
  entryMcUsd?: number;
  athPriceUsd?: number;
  athMcUsd?: number;
  athAt?: number;
  lastPriceUsd?: number;
  lastMcUsd?: number;
  lastCheckedAt?: number;
  timeTo2xSec?: number;
  timeTo5xSec?: number;
  timeTo10xSec?: number;
  rugged?: boolean;
  retired?: boolean;
  /** The pool we first saw this trading in, kept so the peak can be checked against candles. */
  poolAddress?: string;
  /** Where the card went, so a milestone can be reported under the call that made it. */
  postChatId?: string;
  postMessageId?: number;
  postThreadId?: number;
  /** The peak was confirmed against the chart rather than left as whatever we sampled. */
  athFromChart?: boolean;
  /**
   * The entry was read back off the chart at `calledAt`, rather than being the first price we
   * happened to see.
   *
   * Only ever set on a call we found late — one scraped from another group's public feed. It
   * is the flag that separates "this is what they got" from "this is what we saw when we got
   * round to looking", and the scorecard is entitled to throw out any measurement that lacks
   * it rather than quietly ranking a group on our own polling delay.
   */
  entryFromChart?: boolean;
}

/**
 * Numbers known at the moment a call is recorded, for calls that did not happen just now.
 *
 * The live path needs none of this: it hears a call as it is made, so "now" is the call time
 * and the first quote is the entry. A call lifted out of somebody else's feed an hour after
 * they posted it has neither, and inventing them would make a rival's score a function of our
 * scrape interval. Every field here is therefore a fact recovered from a source outside this
 * process — Telegram's own timestamp, or the chart.
 */
export interface TrackSeed {
  /** When the call was actually made. Their clock, never ours. */
  calledAt?: number;
  /** The price at `calledAt`, off the chart. */
  entryPriceUsd?: number;
  entryMcUsd?: number;
  /**
   * The pool, resolved up front rather than on the first poll.
   *
   * Load-bearing for a backfilled call: one already older than the tracking window retires on
   * the very first pass, before any poll has run, and `settle` needs a pool to read the peak
   * from. Without this such a call would be stored with no numbers at all.
   */
  poolAddress?: string;
  entryFromChart?: boolean;
}

/** Identity of the coin itself. EVM addresses are case-insensitive; Solana's are not. */
function coinKey(chain: Chain, address: string): string {
  return chain === 'solana' ? `${chain}:${address}` : `${chain}:${address.toLowerCase()}`;
}

/**
 * One record per source per coin, not one per coin. Three groups calling the same token is
 * the normal case, and the entry each of them actually gave is the only thing that can
 * separate a group that picks well from one we simply happened to read first.
 */
function key(sourceId: string, chain: Chain, address: string): string {
  return `${sourceId}:${coinKey(chain, address)}`;
}

export interface Quote {
  priceUsd?: number;
  mcUsd?: number;
  liquidityUsd?: number;
}

/**
 * Folds one price observation into a tracked call. Pure so the milestone and peak logic
 * can be tested directly — these numbers decide which sources we keep, so being able to
 * assert on them matters more than the plumbing around them.
 */
export function applyQuote(call: TrackedCall, quote: Quote, now: number): void {
  const { priceUsd: price, mcUsd: mc, liquidityUsd } = quote;

  call.lastCheckedAt = now;
  if (mc !== undefined) call.lastMcUsd = mc;

  // Liquidity can vanish while the last quoted price still looks fine, so this is checked
  // before the price guard rather than after it.
  if (liquidityUsd !== undefined && liquidityUsd < RUG_LIQUIDITY_USD) call.rugged = true;

  if (price === undefined || !Number.isFinite(price) || price <= 0) return;
  call.lastPriceUsd = price;

  // A source's quoted market cap is usually rounded and often stale, so the first real
  // observation is a truer entry than whatever the message claimed.
  if (call.entryPriceUsd === undefined) {
    call.entryPriceUsd = price;
    if (mc !== undefined) call.entryMcUsd = mc;
  }

  if (call.athPriceUsd === undefined || price > call.athPriceUsd) {
    call.athPriceUsd = price;
    call.athMcUsd = mc ?? call.athMcUsd;
    call.athAt = now;
  }

  const multiple = price / call.entryPriceUsd;
  const elapsed = Math.round((now - call.calledAt) / 1000);
  if (multiple >= 2 && call.timeTo2xSec === undefined) call.timeTo2xSec = elapsed;
  if (multiple >= 5 && call.timeTo5xSec === undefined) call.timeTo5xSec = elapsed;
  if (multiple >= 10 && call.timeTo10xSec === undefined) call.timeTo10xSec = elapsed;
}

/**
 * Records what happened to every call after we saw it. This is the only honest answer to
 * "is this source worth following" — and it is also the raw material for phase 3's recap
 * videos, which need entry price, peak, and how long the run took.
 *
 * Shadow calls are tracked too. That is the entire point of shadow mode: find out what a
 * group would have made us before trusting it with anything.
 */
export class Tracker {
  private readonly calls = new Map<string, TrackedCall>();
  private dirty = false;
  private timer?: NodeJS.Timeout;

  /** Overridden in tests so they cannot write over the real outcome store — the entries in
   *  it are irreplaceable, since a call's peak can only be measured while it is happening. */
  constructor(private readonly store = STORE) {}

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      const raw = JSON.parse(readFileSync(this.store, 'utf8')) as TrackedCall[];
      for (const c of raw) this.calls.set(key(c.sourceId, c.chain, c.address), c);
      log.debug(`loaded ${this.calls.size} tracked calls`);
    } catch (err) {
      log.warn(`could not read tracked calls: ${(err as Error).message}`);
    }
  }

  /**
   * Called from the router. Cheap and synchronous — the first price fetch is deferred.
   *
   * `seed` is for calls that did not happen just now: it is how a rival's post from an hour ago
   * gets their timestamp and their entry rather than ours. It applies only when the record is
   * created, for the same reason the existing-record branch below keeps the original entry —
   * the first thing we learned about a call is the thing that was true when it was made.
   */
  track(signal: Signal, outcome: Outcome, seed?: TrackSeed): TrackedCall {
    const k = key(signal.source.id, signal.call.token.chain, signal.call.token.address);

    // A call typically arrives as `staged` and is promoted to `called` on approval. Keep
    // the original entry price — that is where we would actually have bought — but record
    // the strongest outcome it reached.
    const existing = this.calls.get(k);
    if (existing) {
      if (RANK[outcome] > RANK[existing.outcome]) {
        existing.outcome = outcome;
        this.dirty = true;
      }
      // Publishing it overrules the decline — a call held back and then approved must not
      // resurface in the feed as one we passed on.
      if (outcome === 'called' && existing.declined) {
        existing.declined = false;
        delete existing.declinedReason;
        this.dirty = true;
      }
      return existing;
    }

    const created: TrackedCall = {
      id: signal.id,
      sourceId: signal.source.id,
      outcome,
      chain: signal.call.token.chain,
      address: signal.call.token.address,
      ticker: signal.call.ticker,
      name: signal.call.name,
      calledAt: seed?.calledAt ?? Date.now(),
      risk: signal.risk.level,
      riskFlags: signal.risk.flags.map((f) => f.code),
      entryMcUsd: seed?.entryMcUsd ?? signal.call.stats.marketCapUsd,
      entryPriceUsd: seed?.entryPriceUsd ?? signal.call.stats.priceUsd,
      poolAddress: seed?.poolAddress,
      entryFromChart: seed?.entryFromChart,
    };
    this.calls.set(k, created);
    this.dirty = true;
    return created;
  }

  /**
   * Where a call's card ended up. Recorded so a milestone can be announced as a reply to the
   * call itself — a number under the original message is checkable at a glance, where the
   * same number in a fresh post is a claim about a call the reader has to go and find.
   */
  published(call: TrackedCall, chatId: string, messageId: number, threadId?: number): void {
    call.postChatId = chatId;
    call.postMessageId = messageId;
    call.postThreadId = threadId;
    this.dirty = true;
  }

  /**
   * A call somebody decided against. Narrower than `staged` on purpose: reaching the war
   * room usually means nobody looked, and "we passed on this" is a claim the X feed makes
   * out loud. The reason is frozen at the moment of the decision, because reconstructing it
   * later from the price is how you end up claiming foresight you did not have.
   */
  decline(signal: Signal, reason?: string): void {
    const call = this.track(signal, 'staged');
    call.declined = true;
    if (reason) call.declinedReason ??= reason;
    this.dirty = true;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.persist();
  }

  /** Calls still worth pricing, and the ones ageing out of the window on this pass. */
  private due(): { active: TrackedCall[]; retiring: TrackedCall[] } {
    const now = Date.now();
    const active: TrackedCall[] = [];
    const retiring: TrackedCall[] = [];
    for (const c of this.calls.values()) {
      if (c.retired) continue;
      if (now - c.calledAt > RETIRE_AFTER_MS) {
        c.retired = true;
        this.dirty = true;
        retiring.push(c);
        continue;
      }
      active.push(c);
    }
    return { active, retiring };
  }

  /**
   * Replaces a sampled peak with the one the chart actually shows.
   *
   * Our own peak is the best of however many samples we managed to take, so downtime — or
   * simply a restart — understates a run that happened in the gap. Done once, at the moment
   * a call leaves the polling window, because that is when the number stops changing and
   * starts being quoted.
   *
   * Normally only raises it. A candle high a little below what we watched happen means the run
   * was sampled in a pool the chart is not quoting, and discarding a real observation for that
   * is worse than keeping a conservative one.
   *
   * Past `CONTRADICTED` that reasoning inverts, and the word "conservative" changes sides. Two
   * live pools of one token are held together by anybody willing to arbitrage them, so they do
   * not sit orders of magnitude apart — a sample that far above the chart is not a pool we
   * failed to quote, it is a number that was never true. Keeping the larger of two readings
   * that disagree like that is not caution, it is picking the one that flatters us. PARKIFY
   * sampled a peak 6,190x its chart, and the rule as written would have made that permanent:
   * a fiction, quoted, on a record whose entire claim is that the chart agrees with it.
   */
  private async settle(call: TrackedCall): Promise<void> {
    if (!call.poolAddress || !call.entryPriceUsd) return;

    // Named, or a pool ordered the other way returns the peak of the coin we did not call.
    const peak = await peakSince(call.chain, call.poolAddress, call.calledAt, undefined, call.address);
    if (!peak) return;

    call.athFromChart = true;
    this.dirty = true;

    const sampled = call.athPriceUsd ?? 0;
    const label = call.ticker ? `$${call.ticker}` : call.address.slice(0, 8);

    if (sampled > peak.priceUsd * CONTRADICTED) {
      log.warn(`${label} sampled a peak ${(sampled / peak.priceUsd).toFixed(0)}x above its own chart — taking the chart`);
    } else if (peak.priceUsd <= sampled) {
      return;
    } else if (sampled) {
      log.info(`${label} peaked ${(peak.priceUsd / sampled).toFixed(2)}x higher than we sampled — corrected from the chart`);
    }

    // Market cap is scaled from entry rather than read off the candle, which carries price
    // only. Supply is fixed for anything we call, so the ratio holds — and a figure derived
    // the same way the multiple is derived cannot contradict it.
    if (call.entryMcUsd) call.athMcUsd = (call.entryMcUsd * peak.priceUsd) / call.entryPriceUsd;
    call.athPriceUsd = peak.priceUsd;
    call.athAt = peak.at;
  }

  /**
   * Prices the peak of every call that has aged out, straight from the chart.
   *
   * The daemon already does this for the calls it is holding, inside `poll()`. Nothing was doing
   * it for the calls the scraper writes, and the reason is worth stating because it is invisible
   * from either side: `merged()` folds the file back in at save time, so a row another process
   * added survives — but it is never loaded into the running daemon's map, so it is never polled
   * and never retired. A scraped call kept its entry price and never got a peak.
   *
   * The scorecard reads peaks. So the failure was that every pass reported success, every row
   * looked complete, and `PRICED` stayed at zero for as long as the daemon happened to stay up —
   * which is the same shape as the chain-slug bug and the entry-price fallback before it. The
   * measurement would have run for two weeks and produced nothing rankable.
   *
   * Live polling is not the fix, and would have been the wrong one even if it worked. A scraped
   * call is being *scored*, not traded: its peak is best read once off the candles, exactly,
   * rather than sampled 1,440 times and still missed if the process blinked. One request per
   * call for its entire life, instead of one a minute.
   *
   * Attempted once each, exactly as `due()` retires the daemon's own: a call we could not price
   * stays unpriced rather than being retried against a rate limit on every pass forever. The
   * cap is per pass, not total — a cold-start backlog drains over the following passes instead
   * of arriving at the candle API as one burst.
   */
  async settleAged(limit = 25): Promise<number> {
    const now = Date.now();
    let priced = 0;
    for (const call of this.calls.values()) {
      if (priced >= limit) break;
      if (call.retired || now - call.calledAt <= RETIRE_AFTER_MS) continue;
      call.retired = true;
      this.dirty = true;
      // Nothing to read a chart with. Retired above regardless, so it is not reconsidered.
      if (!call.poolAddress || !call.entryPriceUsd) continue;
      await this.settle(call);
      priced++;
    }
    this.persist();
    return priced;
  }

  private async poll(): Promise<void> {
    const { active, retiring } = this.due();
    // Sequential, and only ever a handful a day: the candle API allows ~30 requests a minute.
    for (const call of retiring) await this.settle(call);
    if (!active.length) return this.persist();

    // One request slot per coin, not per record. Every source that called a token holds its
    // own record, so a coin four groups shouted about would otherwise eat four of the thirty
    // addresses this request can carry — for four copies of the same price.
    const byCoin = new Map<string, TrackedCall[]>();
    for (const call of active) {
      const k = coinKey(call.chain, call.address);
      const group = byCoin.get(k);
      if (group) group.push(call);
      else byCoin.set(k, [call]);
    }
    const coins = [...byCoin.values()];

    for (let i = 0; i < coins.length; i += BATCH) {
      const batch = coins.slice(i, i + BATCH);
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${batch.map((group) => group[0]!.address).join(',')}`,
          { headers: { accept: 'application/json' } },
        );
        if (!res.ok) continue;

        const body = (await res.json()) as { pairs?: DexPair[] };
        const pairs = body.pairs ?? [];

        for (const group of batch) {
          const call = group[0]!;
          /**
           * The same pool the card was built from, not a second opinion about it.
           *
           * This used to take whichever pool advertised the deepest liquidity, which is the
           * exact fiction `mainPool` was written to reject — and it survived here for as long
           * as it did because the two paths look unrelated: one publishes, one re-prices.
           *
           * PARKIFY caught it. A Meteora pool claiming $1.07bn of depth and a $1.43bn market
           * cap, on a coin genuinely worth $229k, off one transaction in a day. The entry came
           * off the chart and was right; every price after it came from the fiction pool. Five
           * different channels had called that coin, so five of them were about to be credited
           * with a **6,190x** — and a peak is the number the whole scorecard ranks on.
           *
           * Scoped to the chain the call was made on, rather than letting the busiest pool
           * decide: an address can be a different coin elsewhere, and mid-run the namesake can
           * out-trade the real one. `chainFromSlug` because our chain names are not
           * DexScreener's and comparing the raw strings quietly matches nothing.
           */
          const view = aggregate(
            pairs.filter((p) => !p.chainId || chainFromSlug(p.chainId) === call.chain),
            call.address,
          );
          if (view) for (const c of group) this.apply(c, view);
        }
      } catch (err) {
        log.debug(`tracker poll failed: ${(err as Error).message}`);
      }
    }

    this.persist();
  }

  private apply(call: TrackedCall, view: TokenView): void {
    // The pool as it was at call time, not whichever is deepest by the end. Liquidity can
    // migrate mid-run, and only the original is guaranteed to hold candles for the whole
    // window we need to read back.
    call.poolAddress ??= view.best.pairAddress;

    applyQuote(
      call,
      {
        priceUsd: view.stats.priceUsd,
        mcUsd: view.stats.marketCapUsd,
        // Summed across the coin's real pools, as the card does. A rug is called on depth, and
        // reading one pool of several would call it on a coin whose liquidity merely moved.
        liquidityUsd: view.stats.liquidityUsd,
      },
      Date.now(),
    );
    this.dirty = true;
  }

  /** Everything held right now. The scorecard reads the file; this reads the live map. */
  list(): TrackedCall[] {
    return [...this.calls.values()];
  }

  /**
   * What we hold, folded together with what is already on disk.
   *
   * Two processes write this file. The daemon prices calls every minute; `npm run shadow`
   * records what rival channels called. Each holds its own `Tracker` over the same path and
   * each writes the file whole, so without this the one that saved last replaced the other's
   * rows outright — and a row destroyed that way can be unrecoverable, because a peak only
   * exists to be measured while it is happening.
   *
   * Collisions are not a worry: a key is `sourceId + chain + address`, and the two processes
   * write disjoint sources (`tg:*` for scraped channels, ours for ours). So a key on both
   * sides is one record seen twice, and the copy checked more recently holds the newer price.
   * The peak is taken as the larger of the two either way, since it is a running maximum and
   * the one number here that cannot be recovered by looking again.
   *
   * Nothing in this class ever deletes a record, so folding disk back in cannot resurrect
   * something that was meant to be gone.
   */
  private merged(): TrackedCall[] {
    let onDisk: TrackedCall[] = [];
    try {
      if (existsSync(this.store)) onDisk = JSON.parse(readFileSync(this.store, 'utf8')) as TrackedCall[];
    } catch (err) {
      // An unreadable file is not a reason to drop what we are holding.
      log.warn(`could not re-read tracked calls before saving: ${(err as Error).message}`);
      return this.list();
    }

    const out = new Map(this.calls);
    for (const theirs of onDisk) {
      const k = key(theirs.sourceId, theirs.chain, theirs.address);
      const ours = out.get(k);
      if (!ours) {
        out.set(k, theirs);
        continue;
      }
      const fresher = (theirs.lastCheckedAt ?? 0) > (ours.lastCheckedAt ?? 0) ? theirs : ours;
      const higher = (theirs.athPriceUsd ?? 0) > (ours.athPriceUsd ?? 0) ? theirs : ours;
      out.set(
        k,
        higher === fresher
          ? fresher
          : { ...fresher, athPriceUsd: higher.athPriceUsd, athMcUsd: higher.athMcUsd, athAt: higher.athAt },
      );
    }
    return [...out.values()];
  }

  persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify(this.merged(), null, 2));
    } catch (err) {
      log.warn(`could not persist tracked calls: ${(err as Error).message}`);
    }
  }

  static read(): TrackedCall[] {
    if (!existsSync(STORE)) return [];
    return JSON.parse(readFileSync(STORE, 'utf8')) as TrackedCall[];
  }

  get size(): number {
    return this.calls.size;
  }
}
