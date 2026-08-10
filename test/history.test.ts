import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NETWORK, pacing, peakSince, priceAt } from '../src/pipeline/history';
import { log } from '../src/log';
import type { Chain } from '../src/types';

const T0 = 1_700_000_000_000;
const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';

/** [timestampSec, open, high, low, close, volume], newest first, as GeckoTerminal sends it. */
function candles(rows: Array<[number, number]>): string {
  return JSON.stringify({
    data: { attributes: { ohlcv_list: rows.map(([at, high]) => [at / 1000, high * 0.9, high, high * 0.8, high, 1]) } },
  });
}

function serve(body: string, status = 200) {
  const seen: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    seen.push(url);
    return { ok: status === 200, status, json: async () => JSON.parse(body) };
  });
  return seen;
}

// The real queue leaves seconds between requests to stay inside the free tier. Nothing here
// reaches the network, so waiting for it would only make the suite slow.
beforeEach(() => {
  pacing.gapMs = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The rate limit is the one failure on this path that does not look like a failure.
 *
 * A refused request returns undefined, which is indistinguishable from a coin with no history,
 * and the caller falls back to whatever price we can see right now — the exact number the
 * chart lookup exists to keep out of the record. The first full watchlist pass priced 9% of
 * calls off the chart and 91% off our own clock, and reported success the whole way.
 */
describe('being refused by the free tier', () => {
  it('retries a 429 rather than reporting no history', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 429, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { attributes: { ohlcv_list: [[T0 / 1000, 1, 1, 1, 0.5, 1]] } } }),
      };
    });

    expect(await priceAt('solana', POOL, T0 + 60_000)).toBe(0.5);
    expect(n).toBe(2);
  });

  it('gives up loudly rather than silently, once retries are spent', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      n += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    });

    expect(await priceAt('solana', POOL, T0)).toBeUndefined();
    // Four attempts, not one: a single refusal must not be mistaken for an absent chart.
    expect(n).toBe(4);
    // And it says so. Falling back to the live price is a real cost to the measurement, so it
    // is not allowed to happen quietly — that silence is what hid the problem the first time.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toMatch(/rate limited/i);
    warn.mockRestore();
  });
});

describe('reading a peak off the chart', () => {
  it('takes the highest candle in the window', async () => {
    serve(
      candles([
        [T0 + 600_000, 0.004],
        [T0 + 300_000, 0.019],
        [T0, 0.002],
      ]),
    );
    const peak = await peakSince('solana', POOL, T0);
    expect(peak).toEqual({ priceUsd: 0.019, at: T0 + 300_000 });
  });

  // The window is the call's life, not the pool's. A coin that ran before we called it did
  // not run *for us*, and claiming that peak is the difference between a record and a lie.
  it('ignores anything that happened before the call', async () => {
    serve(
      candles([
        [T0 + 60_000, 0.003],
        [T0 - 60_000, 0.5],
      ]),
    );
    const peak = await peakSince('solana', POOL, T0);
    expect(peak).toEqual({ priceUsd: 0.003, at: T0 + 60_000 });
  });

  it('translates our chain names into GeckoTerminal networks', async () => {
    const seen = serve(candles([[T0, 1]]));
    await peakSince('ethereum', POOL, T0);
    expect(seen[0]).toContain('/networks/eth/pools/');
  });

  // Guessing a slug would 404 and read as "this coin has no history", which is indistinguishable
  // from a real answer — so an unmapped chain must not reach the network at all.
  it('does not guess a network it has no slug for', async () => {
    const seen = serve(candles([[T0, 1]]));
    expect(await peakSince('robinhood', POOL, T0)).toBeUndefined();
    expect(seen).toHaveLength(0);
  });

  it('gives no answer rather than a wrong one when the call fails', async () => {
    serve('{}', 429);
    expect(await peakSince('solana', POOL, T0)).toBeUndefined();
  });

  it('survives a pool with no candles at all', async () => {
    serve(JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }));
    expect(await peakSince('solana', POOL, T0)).toBeUndefined();
  });

  /**
   * A chain we can publish but cannot price is the worst shape of bug this file has, because
   * nothing anywhere reports it. The call resolves, the card goes out, and the entry price
   * silently becomes "whatever it cost when we happened to look" — which on a scraped call is
   * hours of move handed to or taken from the group being measured.
   *
   * `base`, `blast`, `sui` and `ton` were all missing while being fully parseable, and it cost
   * a quarter of the sample. The map below is exhaustive over `Chain` on purpose: adding a new
   * chain to the union fails to compile until someone states, here, whether it can be priced.
   */
  it('can price every chain it will accept a call on', () => {
    const priceable: Record<Chain, boolean> = {
      solana: true,
      ethereum: true,
      base: true,
      bsc: true,
      arbitrum: true,
      polygon: true,
      avalanche: true,
      blast: true,
      sui: true,
      tron: true,
      ton: true,
      hyperliquid: true,
      // Not a chain GeckoTerminal indexes, and `unknown` is the absence of an answer rather
      // than a place. Both fall back to the live price, which is the honest thing to do when
      // there is no chart to read — it is the *undeclared* fallbacks above that were the bug.
      robinhood: false,
      unknown: false,
    };

    const missing = Object.entries(priceable)
      .filter(([chain, expected]) => expected && !NETWORK[chain as Chain])
      .map(([chain]) => chain);
    expect(missing).toEqual([]);
  });
});
