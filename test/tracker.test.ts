import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyQuote, bestPeak, Tracker, type TrackedCall } from '../src/track/tracker';
import { pacing } from '../src/pipeline/history';

const T0 = 1_700_000_000_000;

function call(overrides: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'x',
    sourceId: 'soaps',
    outcome: 'called',
    chain: 'solana',
    address: 'Abc',
    calledAt: T0,
    ...overrides,
  };
}

/**
 * The daemon and `npm run shadow` are separate processes holding a Tracker over the same file,
 * and each writes it whole. Before these, whichever saved last replaced the other's rows —
 * so a shadow pass recording three hundred rival calls would be erased by the next price poll,
 * or would itself erase the calls we actually made. Neither leaves a trace; the file simply
 * comes back smaller.
 */
describe('two processes writing the same store', () => {
  function store(rows: TrackedCall[]): string {
    const path = join(mkdtempSync(join(tmpdir(), 'pumpgod-tracker-')), 'tracked.json');
    writeFileSync(path, JSON.stringify(rows));
    return path;
  }

  function saved(path: string): TrackedCall[] {
    return JSON.parse(readFileSync(path, 'utf8')) as TrackedCall[];
  }

  function signalFor(c: TrackedCall) {
    return {
      id: c.id,
      source: { id: c.sourceId, label: c.sourceId, mode: 'shadow' as const, enabled: true },
      chatId: '1',
      messageId: 1,
      rawText: '',
      call: {
        token: { address: c.address, kind: 'solana' as const, chain: c.chain, origin: 'bare' as const, confidence: 1 },
        stats: {},
        candidates: [],
      },
      confirmations: [],
      ageSec: 0,
      stale: false,
      risk: { level: 'clear' as const, flags: [] },
      timings: { messageUnix: 0, recvAt: 0, wallClockMs: T0 },
    };
  }

  it('keeps rows the other process wrote after we loaded', () => {
    const path = store([call({ sourceId: 'ours', address: 'Ours' })]);
    const t = new Tracker(path);
    t.load();

    // The other process appends while we are working.
    writeFileSync(
      path,
      JSON.stringify([call({ sourceId: 'ours', address: 'Ours' }), call({ sourceId: 'tg:rival', address: 'Theirs' })]),
    );

    t.track(signalFor(call({ sourceId: 'ours', address: 'Third' })), 'called');
    t.persist();

    expect(saved(path).map((c) => c.address).sort()).toEqual(['Ours', 'Theirs', 'Third']);
  });

  it('keeps the higher peak, because a peak cannot be measured twice', () => {
    // We saw the top and then went quiet; the other process has checked more recently but
    // only ever saw the retrace. Taking the fresher row wholesale would throw the top away.
    const path = store([
      call({ address: 'Coin', athPriceUsd: 0.002, athMcUsd: 2_000, athAt: T0 + 30_000, lastPriceUsd: 0.001, lastCheckedAt: T0 + 90_000 }),
    ]);
    const t = new Tracker(path);
    t.load();
    const mine = t.list()[0]!;
    mine.athPriceUsd = 0.009;
    mine.athMcUsd = 9_000;
    mine.athAt = T0 + 10_000;
    mine.lastCheckedAt = T0 + 20_000;
    t.track(signalFor(call({ sourceId: 'other', address: 'Anything' })), 'shadow'); // marks dirty
    t.persist();

    const coin = saved(path).find((c) => c.address === 'Coin')!;
    expect(coin.athPriceUsd).toBe(0.009);
    expect(coin.athMcUsd).toBe(9_000);
    // ...while the newer price still comes from whoever looked most recently.
    expect(coin.lastPriceUsd).toBe(0.001);
  });
});

describe('applyQuote', () => {
  it('takes entry from the first real observation', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, mcUsd: 36_000, liquidityUsd: 20_000 }, T0);
    expect(c.entryPriceUsd).toBe(0.001);
    expect(c.entryMcUsd).toBe(36_000);
  });

  it('does not move entry on later observations', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.005, liquidityUsd: 20_000 }, T0 + 60_000);
    expect(c.entryPriceUsd).toBe(0.001);
    expect(c.lastPriceUsd).toBe(0.005);
  });

  it('records milestones once, at the time they were first reached', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.002, liquidityUsd: 20_000 }, T0 + 30_000);
    applyQuote(c, { priceUsd: 0.011, liquidityUsd: 20_000 }, T0 + 90_000);
    // Falling back below a milestone must not rewrite when it was hit.
    applyQuote(c, { priceUsd: 0.0005, liquidityUsd: 20_000 }, T0 + 200_000);

    expect(c.timeTo2xSec).toBe(30);
    expect(c.timeTo5xSec).toBe(90);
    expect(c.timeTo10xSec).toBe(90);
  });

  it('keeps the peak after a retrace', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, mcUsd: 10_000, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.02, mcUsd: 200_000, liquidityUsd: 40_000 }, T0 + 60_000);
    applyQuote(c, { priceUsd: 0.003, mcUsd: 30_000, liquidityUsd: 15_000 }, T0 + 120_000);

    expect(c.athPriceUsd).toBe(0.02);
    expect(c.athMcUsd).toBe(200_000);
    expect(c.athAt).toBe(T0 + 60_000);
    expect(c.lastPriceUsd).toBe(0.003);
  });

  it('flags a rug when liquidity is pulled, even if a price is still quoted', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.0009, liquidityUsd: 12 }, T0 + 60_000);
    expect(c.rugged).toBe(true);
  });

  it('ignores a missing or nonsensical price without corrupting entry', () => {
    const c = call();
    applyQuote(c, { priceUsd: undefined, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0, liquidityUsd: 20_000 }, T0 + 1000);
    applyQuote(c, { priceUsd: Number.NaN, liquidityUsd: 20_000 }, T0 + 2000);
    expect(c.entryPriceUsd).toBeUndefined();

    applyQuote(c, { priceUsd: 0.004, liquidityUsd: 20_000 }, T0 + 3000);
    expect(c.entryPriceUsd).toBe(0.004);
  });
});

/**
 * A scraped call is only measured once its peak is known, and for a long time nothing knew it.
 *
 * `npm run shadow` records rival calls with an entry price read off the chart at the minute they
 * were posted. The peak has to come later, from the same chart. The daemon does that for its own
 * calls inside `poll()` — but it polls the map it loaded at startup, and `merged()` folds the
 * file back in only when *writing*. So a row another process appended survived every save and
 * still never got polled, never retired, and never priced.
 *
 * Nothing about that looks wrong from either side. The scraper reports rows recorded, the file
 * grows, every entry price is present and correct — and `PRICED` on the scorecard stays at zero
 * for as long as the daemon stays up. Two weeks of measurement would have ranked nobody.
 */
describe('pricing the peak of a call the daemon never held', () => {
  const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
  const DAY = 24 * 60 * 60 * 1000;

  function scraped(overrides: Partial<TrackedCall> = {}): TrackedCall {
    return call({
      id: 'shadow-tg:rival-1',
      sourceId: 'tg:rival',
      outcome: 'shadow',
      entryPriceUsd: 0.001,
      entryMcUsd: 100_000,
      poolAddress: POOL,
      ...overrides,
    });
  }

  /** Newest first, as GeckoTerminal sends it: [seconds, o, h, l, c, v]. */
  function serveHigh(high: number): void {
    pacing.gapMs = 0;
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { attributes: { ohlcv_list: [[T0 / 1000 + 3600, high * 0.9, high, high * 0.8, high, 1]] } },
      }),
    }));
  }

  function loaded(rows: TrackedCall[]): Tracker {
    const path = join(mkdtempSync(join(tmpdir(), 'pumpgod-settle-')), 'tracked.json');
    writeFileSync(path, JSON.stringify(rows));
    const t = new Tracker(path);
    t.load();
    return t;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('prices a scraped call once it is past the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    serveHigh(0.004);

    const tracker = loaded([scraped()]);
    expect(await tracker.settleAged()).toBe(1);

    const [row] = tracker.list();
    // 0.001 in, 0.004 at the high: the 4x is the whole point of recording the call at all.
    expect(row?.athPriceUsd).toBe(0.004);
    expect(row?.athFromChart).toBe(true);
    expect(row?.athMcUsd).toBe(400_000);
  });

  it('leaves a call still inside its window alone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
    serveHigh(0.004);

    const tracker = loaded([scraped()]);
    expect(await tracker.settleAged()).toBe(0);
    expect(tracker.list()[0]?.athPriceUsd).toBeUndefined();
    // Not retired either: the peak is still being set, and this pass must not close the book.
    expect(tracker.list()[0]?.retired).toBeFalsy();
  });

  /**
   * The rate limit is the reason this matters. A row the candle API refuses looks exactly like a
   * coin with no history, so retrying it would spend the whole budget on the calls least likely
   * to yield anything — every pass, forever, starving the ones that would.
   */
  it('tries each call once, even when the chart gives nothing back', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    pacing.gapMs = 0;
    let requests = 0;
    vi.stubGlobal('fetch', async () => {
      requests++;
      return { ok: false, status: 429, json: async () => ({}) };
    });

    const tracker = loaded([scraped()]);
    await tracker.settleAged();
    const afterFirst = requests;
    await tracker.settleAged();

    expect(afterFirst).toBeGreaterThan(0);
    expect(requests).toBe(afterFirst);
    expect(tracker.list()[0]?.athPriceUsd).toBeUndefined();
  });

  it('drains a backlog across passes rather than in one burst', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    serveHigh(0.002);

    const rows = Array.from({ length: 7 }, (_, i) =>
      scraped({ id: `shadow-tg:rival-${i}`, address: `Addr${i}` }),
    );
    const tracker = loaded(rows);

    expect(await tracker.settleAged(3)).toBe(3);
    expect(await tracker.settleAged(3)).toBe(3);
    expect(await tracker.settleAged(3)).toBe(1);
    expect(await tracker.settleAged(3)).toBe(0);
    expect(tracker.list().every((c) => c.athPriceUsd === 0.002)).toBe(true);
  });

  /**
   * The sampled peak is normally the one worth keeping, so this pair has to stay a pair: the
   * chart is allowed to overrule a sample only when the two are further apart than two real
   * pools of one coin can be. Below that, a lower candle high means the run happened somewhere
   * the chart is not quoting, and throwing away a real observation for it would understate us.
   */
  it('keeps a sampled peak the chart merely fails to confirm', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    serveHigh(0.004);

    const tracker = loaded([scraped({ athPriceUsd: 0.006, athMcUsd: 600_000 })]);
    await tracker.settleAged();

    expect(tracker.list()[0]?.athPriceUsd).toBe(0.006);
  });

  /**
   * PARKIFY. A peak sampled off a pool advertising $1.07bn against a coin worth $229k, which the
   * chart puts 6,190x lower. The old rule only ever raised the peak, so the fiction would have
   * outlived the bug that produced it — quoted forever on a record whose one claim is that the
   * chart agrees with it.
   */
  it('takes the chart over a sample the chart flatly contradicts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    serveHigh(0.002);

    const tracker = loaded([scraped({ athPriceUsd: 1.43, athMcUsd: 1_431_035_025 })]);
    await tracker.settleAged();

    const [row] = tracker.list();
    expect(row?.athPriceUsd).toBe(0.002);
    // Scaled from the entry, so the market cap cannot be left describing the price we dropped.
    expect(row?.athMcUsd).toBe(200_000);
  });

  it('writes the peak to disk without dropping what another process added', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + DAY + 60_000);
    serveHigh(0.005);

    const path = join(mkdtempSync(join(tmpdir(), 'pumpgod-settle-')), 'tracked.json');
    writeFileSync(path, JSON.stringify([scraped()]));
    const tracker = new Tracker(path);
    tracker.load();

    // The daemon publishes one of its own while the shadow pass is mid-flight.
    writeFileSync(
      path,
      JSON.stringify([scraped(), call({ id: 'ours', sourceId: 'manual', address: 'Ours' })]),
    );

    await tracker.settleAged();

    const saved = JSON.parse(readFileSync(path, 'utf8')) as TrackedCall[];
    expect(saved).toHaveLength(2);
    expect(saved.find((c) => c.id === 'ours')).toBeDefined();
    expect(saved.find((c) => c.id === 'shadow-tg:rival-1')?.athPriceUsd).toBe(0.005);
  });
});

/**
 * Two processes write this file, and each holds every row it loaded for as long as it runs.
 *
 * That is what makes this rule load-bearing rather than housekeeping. An overnight
 * `npm run shadow` keeps a stale copy of a call the daemon has since settled off the chart, and
 * under a plain "larger peak wins" it would re-write its own sample over the corrected number
 * on every save, for as long as the loop lived — a correction that does not stay corrected,
 * which is worse than no correction at all because it looks like one.
 */
describe('folding two processes’ copies of a peak together', () => {
  const sampled = { athPriceUsd: 1.43 };
  const settled = { athPriceUsd: 0.0002, athFromChart: true };

  it('prefers the chart over a larger sample', () => {
    expect(bestPeak(sampled, settled)).toBe(settled);
    expect(bestPeak(settled, sampled)).toBe(settled);
  });

  it('prefers the larger when neither has been settled', () => {
    const small = { athPriceUsd: 0.001 };
    expect(bestPeak(sampled, small)).toBe(sampled);
    expect(bestPeak(small, sampled)).toBe(sampled);
  });

  /**
   * Both read the same candles, so they should agree; where they do not, one ran before a
   * further high and the window only ever grows.
   */
  it('prefers the larger when both came from the chart', () => {
    const later = { athPriceUsd: 0.9, athFromChart: true };
    expect(bestPeak(settled, later)).toBe(later);
  });

  it('treats a call nobody has priced as the lesser', () => {
    const blank = {};
    expect(bestPeak(blank, sampled)).toBe(sampled);
    expect(bestPeak(blank, settled)).toBe(settled);
  });
});

/**
 * Re-pricing must choose the pool the same way the card did.
 *
 * The poll used to take whichever pool advertised the deepest liquidity — the exact fiction
 * `mainPool` was written to reject. It survived because the two paths look unrelated: one
 * publishes a card, one re-prices it later, and nobody reads them together.
 *
 * PARKIFY exposed it. A Meteora pool claiming $1.07bn of depth and a $1.43bn market cap, on a
 * coin genuinely worth $229k, off a single transaction in a day. The entry came off the chart
 * and was correct; every price after it came from the fiction. Five channels had called that
 * coin, so five of them were about to be credited with a 6,190x — and the peak is the number
 * the entire scorecard ranks on.
 */
describe('choosing the pool to re-price from', () => {
  const REAL = { liquidity: { usd: 35_000 }, volume: { h24: 120_000 }, priceUsd: '0.000231', marketCap: 229_473 };
  const FICTION = { liquidity: { usd: 1_070_000_000 }, volume: { h24: 1 }, priceUsd: '1.43', marketCap: 1_431_035_025 };

  function pairs(...rows: Array<Record<string, unknown>>) {
    return rows.map((r, i) => ({
      chainId: 'solana',
      pairAddress: `pool-${i}`,
      baseToken: { address: 'Coin', name: 'Parkify', symbol: 'PARKIFY' },
      ...r,
    }));
  }

  async function polled(body: unknown): Promise<TrackedCall> {
    const path = join(mkdtempSync(join(tmpdir(), 'pumpgod-poll-')), 'tracked.json');
    writeFileSync(path, JSON.stringify([call({ address: 'Coin', chain: 'solana', calledAt: Date.now() })]));
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => body }));

    const tracker = new Tracker(path);
    tracker.load();
    tracker.start(600_000);
    await new Promise((r) => setTimeout(r, 30));
    tracker.stop();
    return tracker.list()[0]!;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('takes the pool with the trading, not the one advertising depth', async () => {
    const row = await polled({ pairs: pairs(FICTION, REAL) });
    expect(row.lastPriceUsd).toBe(0.000231);
    expect(row.lastMcUsd).toBe(229_473);
  });

  it('does not let a fiction pool set the peak the scorecard ranks on', async () => {
    const row = await polled({ pairs: pairs(FICTION, REAL) });
    // 6,190x against a $229k coin, from one transaction. It must never enter the record.
    expect(row.athPriceUsd).toBe(0.000231);
  });

  it('ignores a pool for the same address on another chain', async () => {
    const row = await polled({
      pairs: [
        ...pairs(REAL),
        {
          chainId: 'base',
          pairAddress: 'imposter',
          baseToken: { address: 'Coin', name: 'Namesake', symbol: 'COIN' },
          liquidity: { usd: 900_000 },
          volume: { h24: 5_000_000 },
          priceUsd: '9.99',
          marketCap: 50_000_000,
        },
      ],
    });
    expect(row.lastPriceUsd).toBe(0.000231);
  });

  /**
   * Depth is a whole-coin number, so reading it off one pool calls a rug on a coin whose
   * liquidity is merely spread out. Both pools here sit under the rug floor on their own and
   * clear it together, which is the only arrangement that tells the two readings apart.
   */
  it('sums depth across the coin’s real pools rather than reading one', async () => {
    const row = await polled({
      pairs: pairs(
        { liquidity: { usd: 300 }, volume: { h24: 120_000 }, priceUsd: '0.000231', marketCap: 229_473 },
        { liquidity: { usd: 300 }, volume: { h24: 400 }, priceUsd: '0.000230', marketCap: 229_000 },
      ),
    });
    expect(row.rugged).toBeFalsy();
    expect(row.lastPriceUsd).toBe(0.000231);
  });
});
