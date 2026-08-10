import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyQuote, Tracker, type TrackedCall } from '../src/track/tracker';
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
