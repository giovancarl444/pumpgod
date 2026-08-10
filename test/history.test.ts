import { afterEach, describe, expect, it, vi } from 'vitest';
import { peakSince } from '../src/pipeline/history';

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

afterEach(() => {
  vi.unstubAllGlobals();
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
});
