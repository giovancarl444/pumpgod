import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { peakSince } from '../pipeline/history';
import type { DexPair } from '../pipeline/dexscreener';
import type { Chain, RiskLevel, Signal } from '../types';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/tracked.json');

/** DexScreener accepts up to 30 comma-separated addresses per request. */
const BATCH = 30;

/** After a day the outcome is decided; polling longer just burns quota. */
const RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Below this, the pool is gone in any practical sense. */
const RUG_LIQUIDITY_USD = 500;

export type Outcome = 'called' | 'staged' | 'shadow' | 'dry-run' | 'duplicate';

const RANK: Record<Outcome, number> = { duplicate: 0, shadow: 1, 'dry-run': 2, staged: 3, called: 4 };

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

  /** Called from the router. Cheap and synchronous — the first price fetch is deferred. */
  track(signal: Signal, outcome: Outcome): TrackedCall {
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
      calledAt: Date.now(),
      risk: signal.risk.level,
      riskFlags: signal.risk.flags.map((f) => f.code),
      entryMcUsd: signal.call.stats.marketCapUsd,
      entryPriceUsd: signal.call.stats.priceUsd,
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
   * Only ever raises it. A candle high below what we watched happen means we are reading a
   * different pool than we priced, and discarding a real observation for that is worse than
   * keeping a conservative one.
   */
  private async settle(call: TrackedCall): Promise<void> {
    if (!call.poolAddress || !call.entryPriceUsd) return;

    const peak = await peakSince(call.chain, call.poolAddress, call.calledAt);
    if (!peak) return;

    call.athFromChart = true;
    this.dirty = true;
    if (peak.priceUsd <= (call.athPriceUsd ?? 0)) return;

    // Market cap is scaled from entry rather than read off the candle, which carries price
    // only. Supply is fixed for anything we call, so the ratio holds — and a figure derived
    // the same way the multiple is derived cannot contradict it.
    const missed = call.athPriceUsd ? peak.priceUsd / call.athPriceUsd : 1;
    if (call.entryMcUsd) call.athMcUsd = (call.entryMcUsd * peak.priceUsd) / call.entryPriceUsd;
    call.athPriceUsd = peak.priceUsd;
    call.athAt = peak.at;

    const label = call.ticker ? `$${call.ticker}` : call.address.slice(0, 8);
    log.info(`${label} peaked ${missed.toFixed(2)}x higher than we sampled — corrected from the chart`);
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
        const best = new Map<string, DexPair>();
        for (const pair of body.pairs ?? []) {
          const addr = pair.baseToken?.address;
          if (!addr) continue;
          const k = addr.toLowerCase();
          const current = best.get(k);
          if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(k, pair);
        }

        for (const group of batch) {
          const pair = best.get(group[0]!.address.toLowerCase());
          if (pair) for (const call of group) this.apply(call, pair);
        }
      } catch (err) {
        log.debug(`tracker poll failed: ${(err as Error).message}`);
      }
    }

    this.persist();
  }

  private apply(call: TrackedCall, pair: DexPair): void {
    // The pool as it was at call time, not whichever is deepest by the end. Liquidity can
    // migrate mid-run, and only the original is guaranteed to hold candles for the whole
    // window we need to read back.
    call.poolAddress ??= pair.pairAddress;

    applyQuote(
      call,
      {
        priceUsd: pair.priceUsd ? Number(pair.priceUsd) : undefined,
        mcUsd: pair.marketCap ?? pair.fdv,
        liquidityUsd: pair.liquidity?.usd,
      },
      Date.now(),
    );
    this.dirty = true;
  }

  /** Everything held right now. The scorecard reads the file; this reads the live map. */
  list(): TrackedCall[] {
    return [...this.calls.values()];
  }

  persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify(this.list(), null, 2));
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
