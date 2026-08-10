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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      log.debug(`ohlcv ${pool}: HTTP ${res.status}`);
      return undefined;
    }

    // [timestampSec, open, high, low, close, volume], newest first.
    const body = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const candles = body.data?.attributes?.ohlcv_list;
    if (!candles?.length) return undefined;

    let best: Peak | undefined;
    for (const candle of candles) {
      const at = (candle[0] ?? 0) * 1000;
      const high = candle[2];
      if (at < sinceMs || high === undefined || !Number.isFinite(high) || high <= 0) continue;
      if (!best || high > best.priceUsd) best = { priceUsd: high, at };
    }
    return best;
  } catch (err) {
    if ((err as Error).name !== 'AbortError') log.debug(`ohlcv ${pool} failed: ${(err as Error).message}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
