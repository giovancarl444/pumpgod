import { log } from '../log';
import type { Chain } from '../types';

const BASE = 'https://api.geckoterminal.com/api/v2';

/**
 * GeckoTerminal's network slugs, which are not our chain names and not DexScreener's either
 * — `ethereum` is `eth`, `polygon` is `polygon_pos`. Only slugs confirmed against the live
 * `/networks` index are listed; an unmapped chain skips the backfill rather than guessing a
 * slug, because a wrong one 404s silently and looks exactly like a coin with no history.
 */
const NETWORK: Partial<Record<Chain, string>> = {
  solana: 'solana',
  ethereum: 'eth',
  bsc: 'bsc',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  arbitrum: 'arbitrum',
  tron: 'tron',
  hyperliquid: 'hyperliquid',
};

/** 5-minute candles for 24h is 288, comfortably inside the 1000-candle ceiling. */
const AGGREGATE_MIN = 5;
const LIMIT = 288;

export interface Peak {
  priceUsd: number;
  at: number;
}

/**
 * The free tier allows roughly thirty calls a minute and answers the thirty-first with a 429
 * rather than a wait.
 *
 * This matters more than a rate limit usually would, because of the *shape* of the failure. A
 * refused candle request raises nothing anybody sees: `priceAt` returns undefined, the caller
 * shrugs and falls back to the price we happened to observe, and the record fills up with
 * exactly the number this module exists to keep out of it. The first full pass over the
 * watchlist priced 9% of calls off the chart and 91% off our own clock, and every log line and
 * summary it printed looked perfectly healthy.
 *
 * So requests are spaced instead of raced. Nothing on this path is latency-sensitive — the
 * entire premise of measuring rivals by scraping is that a call found late scores the same as
 * one found live — which makes a queue close to free here and the silence expensive.
 *
 * Spacing is per process. The daemon backfills a peak only at retirement, a handful of times a
 * day, so the two processes sharing the quota is not worth coordinating over.
 */
const RETRIES = 3;

/**
 * Set to zero by tests, which stub `fetch` and would otherwise sit through a real queue to
 * reach a canned answer. Exposed as a field rather than a constant so the wait is one place
 * both here and in a test, instead of a duplicated number that can drift.
 */
export const pacing = { gapMs: 2_200 };

/** Earliest moment the next request may leave, moved forward by each caller in turn. */
let nextSlot = 0;

async function pace(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + pacing.gapMs;
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
}

/**
 * `[timestampSec, open, high, low, close, volume]`, newest first.
 *
 * Returns undefined for "no answer", which every caller treats as "no history" — hence the
 * warning when the cause was a refusal rather than an absence. The two are indistinguishable
 * downstream and only one of them is our fault.
 */
async function candles(url: string, label: string, timeoutMs: number): Promise<number[][] | undefined> {
  for (let attempt = 0; ; attempt++) {
    await pace();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });

      if (res.status === 429) {
        if (attempt >= RETRIES) {
          log.warn(`ohlcv ${label}: rate limited, giving up — this price will fall back to what we can see now`);
          return undefined;
        }
        // Hold everybody back, not just this caller: the limit counts requests, not callers.
        nextSlot = Math.max(nextSlot, Date.now() + pacing.gapMs * 2 ** (attempt + 1));
        continue;
      }

      if (!res.ok) {
        log.debug(`ohlcv ${label}: HTTP ${res.status}`);
        return undefined;
      }

      const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
      return body.data?.attributes?.ohlcv_list;
    } catch (err) {
      if ((err as Error).name !== 'AbortError') log.debug(`ohlcv ${label} failed: ${(err as Error).message}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * What a coin cost at a particular minute, read off the chart.
 *
 * This is what makes measuring a rival group by scraping honest. We find their posts minutes
 * or hours after they were made, and if the entry we recorded were simply the price when *we*
 * looked, then a group we happened to poll late would score differently from one we polled
 * promptly — we would be measuring our own latency and publishing it as their skill. Reading
 * the price back at the minute they actually posted removes our clock from the number
 * entirely, which is the whole reason a slow scraper can replace a logged-in reader for
 * scoring.
 *
 * One-minute candles, and only a handful of them: `before_timestamp` does the seeking
 * server-side, so this costs the same single request whether the post is five minutes or five
 * hours old.
 */
export async function priceAt(
  chain: Chain,
  pool: string,
  atMs: number,
  timeoutMs = 8000,
): Promise<number | undefined> {
  const network = NETWORK[chain];
  if (!network) return undefined;

  const at = Math.floor(atMs / 1000);
  // `before_timestamp` is exclusive of the minute it lands in, so asking for the post's own
  // minute would return the one before it. Two minutes of slack covers that and any skew
  // between Telegram's clock and the chain's.
  const url =
    `${BASE}/networks/${network}/pools/${encodeURIComponent(pool)}/ohlcv/minute` +
    `?aggregate=1&limit=5&before_timestamp=${at + 120}&currency=usd`;

  const list = await candles(url, `at ${pool}`, timeoutMs);
  if (!list?.length) return undefined;

  // The newest candle that had already opened when they posted, and its close — the price
  // about a minute *after* the call. Somebody reading the message cannot buy at a price that
  // existed before they read it, so the close is the first figure anyone could actually have
  // paid. A minute with no trades has no candle at all, in which case this falls back to the
  // last price that really traded, which is the right answer for the same reason.
  let best: { at: number; close: number } | undefined;
  for (const candle of list) {
    const opened = (candle[0] ?? 0) * 1000;
    const close = candle[4];
    if (opened > atMs || close === undefined || !Number.isFinite(close) || close <= 0) continue;
    if (!best || opened > best.at) best = { at: opened, close };
  }
  return best?.close;
}

/**
 * The highest price a pool actually traded at since a given moment, read off candles.
 *
 * This exists because the tracker's own peak is the maximum of the samples it happened to
 * take — so a restart, or any gap in polling, silently understates a run. The public claim
 * is "check our numbers against the chart", and a number the chart does not show is the
 * whole thesis leaking, in either direction.
 *
 * A candle's `high` is the true maximum within its period, so 5-minute buckets lose only the
 * precision of *when* the peak landed, never the peak itself.
 *
 * Free tier, no key, roughly 30 requests a minute and 180 days of history. Both limits are
 * far away here: this is called once per call, at retirement, against a 24h window.
 */
export async function peakSince(
  chain: Chain,
  pool: string,
  sinceMs: number,
  timeoutMs = 8000,
): Promise<Peak | undefined> {
  const network = NETWORK[chain];
  if (!network) return undefined;

  const url =
    `${BASE}/networks/${network}/pools/${encodeURIComponent(pool)}/ohlcv/minute` +
    `?aggregate=${AGGREGATE_MIN}&limit=${LIMIT}&currency=usd`;

  const list = await candles(url, `peak ${pool}`, timeoutMs);
  if (!list?.length) return undefined;

  let best: Peak | undefined;
  for (const candle of list) {
    const at = (candle[0] ?? 0) * 1000;
    const high = candle[2];
    if (at < sinceMs || high === undefined || !Number.isFinite(high) || high <= 0) continue;
    if (!best || high > best.priceUsd) best = { priceUsd: high, at };
  }
  return best;
}
