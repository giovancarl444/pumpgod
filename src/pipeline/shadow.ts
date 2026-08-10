import { log } from '../log';
import { readCallPost } from '../parse/callpost';
import type { Watched } from '../store/watched';
import { fetchPreview, type PreviewPost } from '../telegram/webpreview';
import type { Tracker } from '../track/tracker';
import type { Chain, ParsedCall, Signal, Source } from '../types';
import { priceAt } from './history';
import { resolveManualCall } from './manual';
import { assess } from './risk';

/**
 * Measuring the groups we might one day copy, without an account and without joining anything.
 *
 * ## The one thing this file cannot do
 *
 * It cannot publish. There is no `Transport` here, no channel peer, no `Router` — the only
 * thing it writes to is the tracker, and the only outcome it ever writes is `shadow`. That is
 * not a setting; there is no mode field to get wrong, no config value that turns it on, and no
 * code path from a scraped post to the channel. Given that every record produced here comes
 * from a stranger's message that nobody on our side has read, that guarantee is worth more than
 * any convenience a shared pipeline would have bought.
 *
 * ## Why a scraper is enough
 *
 * The plan called for a logged-in reader account to watch rival groups, and that account is
 * bannable and has to join eighty of them to be useful. But scoring a group needs no speed at
 * all — only copying one does. The times come off Telegram's own `datetime` attribute and the
 * prices come off the chart at that minute, so a call found two hours late is scored exactly as
 * it would have been if we had seen it live. The account risk therefore moves to the end, taken
 * on the two or three groups a real record justifies, instead of on eighty of them up front.
 *
 * That equivalence is a property of this file and it is easy to lose. If the entry price were
 * ever read at scrape time instead of at post time, every number below would become a function
 * of our poll interval, and a group would score well or badly according to how promptly we
 * happened to look at it. See `seedFor`.
 */

/** Nothing here is our call, and nothing here can become one. */
const OUTCOME = 'shadow' as const;

/**
 * Calls older than this are not recorded.
 *
 * Not because they cannot be measured — candles reach back far enough that they can be, exactly.
 * It is that the first pass over eighty channels would otherwise record several hundred calls
 * in one burst, each needing two API round trips, and the answer to most of them is already
 * settled. Twelve hours keeps a cold start honest and cheap, and after the first pass a channel
 * rarely has more than one or two new posts anyway.
 */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * How many calls a single channel can contribute in one pass.
 *
 * Only ever bites on a cold start, where twenty unread posts arrive at once. A steady pass sees
 * a handful. Deliberately low: the point is to start the clock, not to reconstruct history.
 */
const MAX_NEW = 6;

/** Between channels, so eighty handles do not arrive at t.me as a burst. */
const PACE_MS = 400;

export interface ShadowDeps {
  /** Public @handles. No ids, no peers — nothing here is joined. */
  handles: string[];
  tracker: Tracker;
  seen: Watched;
  /** Chains we can price and screen. Anything else is skipped rather than half-recorded. */
  chains?: Chain[];
  maxAgeMs?: number;
  maxNew?: number;
  paceMs?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Injected in tests, so a pass can be driven from saved pages with no network at all. */
  fetchPosts?: (handle: string, before?: number) => Promise<PreviewPost[]>;
  resolve?: typeof resolveManualCall;
  entryPriceAt?: typeof priceAt;
}

export interface HandleResult {
  handle: string;
  /** Posts on the page that we had not already considered. */
  fresh: number;
  recorded: number;
  /** Why the rest were passed over, counted by reason. The health check on the whole scraper. */
  skipped: Record<string, number>;
}

/**
 * One sweep of every watched channel.
 *
 * Sequential on purpose. Eighty parallel fetches would be faster and would also be the most
 * conspicuous thing anyone has ever pointed at `t.me`, and there is nothing to be fast for —
 * see the note at the top of the file.
 */
export async function shadowPass(deps: ShadowDeps): Promise<HandleResult[]> {
  const {
    handles,
    tracker,
    seen,
    chains,
    maxAgeMs = MAX_AGE_MS,
    maxNew = MAX_NEW,
    paceMs = PACE_MS,
    timeoutMs = 10_000,
    now = Date.now,
    fetchPosts = (handle) => fetchPreview(handle, { timeoutMs }),
    resolve = resolveManualCall,
    entryPriceAt = priceAt,
  } = deps;

  const results: HandleResult[] = [];

  for (const handle of handles) {
    const result: HandleResult = { handle, fresh: 0, recorded: 0, skipped: {} };
    results.push(result);
    const skip = (why: string) => {
      result.skipped[why] = (result.skipped[why] ?? 0) + 1;
    };

    const posts = await fetchPosts(handle);
    if (!posts.length) {
      const misses = seen.missed(handle, now());
      // Three passes with nothing readable is a handle that has gone private, renamed or
      // switched its preview off. Said out loud once, at the point it becomes true, rather
      // than left as a channel that quietly contributes nothing forever.
      if (misses === 3) log.warn(`@${handle} has returned nothing ${misses} passes running — check the handle`);
      continue;
    }

    const from = seen.lastId(handle) ?? 0;
    // Oldest first, so the mark advances monotonically and a crash mid-channel re-reads only
    // what it had not finished.
    const fresh = posts.filter((p) => p.id > from).sort((a, b) => a.id - b.id);
    result.fresh = fresh.length;

    let recorded = 0;
    let mark = from;
    for (const post of fresh) {
      mark = Math.max(mark, post.id);

      if (now() - post.at > maxAgeMs) {
        skip('too-old');
        continue;
      }

      const read = readCallPost(post.text);
      if (!read.call) {
        skip(read.why);
        continue;
      }

      if (recorded >= maxNew) {
        skip('over-cap');
        continue;
      }

      const why = await record(handle, post, read.address, {
        tracker,
        chains,
        timeoutMs,
        resolve,
        entryPriceAt,
      });
      if (why) skip(why);
      else recorded += 1;
    }

    result.recorded = recorded;
    seen.seen(handle, mark, now());

    // Saved per channel rather than once at the end. A full pass waits out the candle API for
    // several minutes, and a ctrl-c or a crash nine minutes in would otherwise throw away
    // every call measured so far — including, for a channel that has since deleted a losing
    // post, calls that cannot be read again at any price. Both stores no-op when unchanged.
    tracker.persist();
    seen.persist();

    if (paceMs) await sleep(paceMs);
  }

  return results;
}

interface RecordDeps {
  tracker: Tracker;
  chains?: Chain[];
  timeoutMs: number;
  resolve: typeof resolveManualCall;
  entryPriceAt: typeof priceAt;
}

/** Returns a skip reason, or `undefined` if the call was recorded as a new row. */
async function record(
  handle: string,
  post: PreviewPost,
  address: string,
  deps: RecordDeps,
): Promise<string | undefined> {
  const { tracker, chains, timeoutMs, resolve, entryPriceAt } = deps;

  // The same resolver the `/signal` command uses, which means a chart link, a pump.fun URL and
  // a bare mint all land in the same place — and a pool address resolves back to the token it
  // holds rather than being recorded as a coin in its own right.
  //
  // No RPC is passed. Reading the mint would tell us whether *they* called something with a
  // live freeze authority, which is interesting, but it is a round trip per call on a path with
  // eighty channels behind it and it changes no number on the scorecard.
  const resolved = await resolve(address, timeoutMs, chains);
  if (!resolved.ok) return 'unresolved';

  const call = resolved.call;
  const seed = await seedFor(call, post.at, entryPriceAt);

  // A channel that posts the same coin twice in a window is one call, not two. The tracker
  // already keeps the first — this only stops the pass *reporting* two, which would inflate
  // the one number the scorecard's sample threshold is counted against.
  const before = tracker.size;
  tracker.track(signalFor(handle, post, call), OUTCOME, seed);
  return tracker.size > before ? undefined : 'repost';
}

/**
 * The numbers as they stood when *they* posted, not when we found it.
 *
 * This is the whole reason a slow scraper can stand in for a live reader. `resolveManualCall`
 * just handed us the price now, which for a post two hours old is two hours of move we would be
 * quietly crediting to — or blaming on — the group that called it.
 *
 * Market cap is scaled from the entry price rather than read separately, because supply is
 * fixed for anything in this market: one number derived from the other cannot contradict it,
 * where two independently sourced figures eventually will.
 *
 * When the chart cannot answer — a pool too new to be indexed, an unmapped chain — the live
 * price is used and `entryFromChart` is left unset. That is not a small caveat and the flag is
 * how the scorecard is entitled to drop the row: a coin that dumped between their post and our
 * pass gets an entry lower than anyone could have taken, which *flatters* the group, and one
 * that ran gets an entry nobody could have taken either, which buries them. It is wrong in both
 * directions, so it is marked rather than hidden.
 */
async function seedFor(call: ParsedCall, at: number, entryPriceAt: typeof priceAt) {
  const livePrice = call.stats.priceUsd;
  const liveMc = call.stats.marketCapUsd;
  const pool = call.pairAddress;

  // Named, so the candles come back for this coin rather than whatever the pool's other side
  // happens to be. See `side` in history.ts — the pair is not always ordered our way.
  const entry = pool
    ? await entryPriceAt(call.token.chain, pool, at, undefined, call.token.address)
    : undefined;
  if (entry === undefined) {
    return {
      calledAt: at,
      entryPriceUsd: livePrice,
      entryMcUsd: liveMc,
      poolAddress: pool,
    };
  }

  return {
    calledAt: at,
    entryPriceUsd: entry,
    entryMcUsd: liveMc && livePrice ? (liveMc * entry) / livePrice : undefined,
    poolAddress: pool,
    entryFromChart: true,
  };
}

/**
 * A source id per channel, in its own namespace.
 *
 * `tg:` keeps a scraped record from ever merging with the same group read over MTProto later.
 * They would be two measurements of the same channel taken by different means with different
 * latencies, and averaging them together would produce a number that describes neither.
 */
export function sourceIdFor(handle: string): string {
  return `tg:${handle.replace(/^@/, '').toLowerCase()}`;
}

function signalFor(handle: string, post: PreviewPost, call: ParsedCall): Signal {
  const source: Source = {
    id: sourceIdFor(handle),
    label: `@${handle}`,
    username: handle,
    mode: 'shadow',
    enabled: true,
  };

  return {
    id: `shadow-${sourceIdFor(handle)}-${post.id}`,
    source,
    // Their message, addressed the way Telegram itself addresses it, so a record can be opened
    // and checked against the post it came from.
    chatId: `t.me/${handle}`,
    messageId: post.id,
    rawText: post.text,
    call,
    confirmations: [],
    ageSec: Math.max(0, Math.round((Date.now() - post.at) / 1000)),
    // Every scraped call is stale by construction. Nothing reads this — there is no publishing
    // path out of here — but leaving it false would be a lie waiting for someone to trust it.
    stale: true,
    // Read against live market data, since that is all we have. Kept because "what fraction of
    // this group's calls were untradable at the time" is a real question about a group, and the
    // answer is only available at the moment we record it.
    risk: assess(call, undefined, true),
    enriched: true,
    timings: {
      messageUnix: Math.floor(post.at / 1000),
      recvAt: performance.now(),
      wallClockMs: Date.now(),
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}
