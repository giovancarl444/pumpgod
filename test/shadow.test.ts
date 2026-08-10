import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { shadowPass, sourceIdFor } from '../src/pipeline/shadow';
import { Watched } from '../src/store/watched';
import { Tracker } from '../src/track/tracker';
import type { PreviewPost } from '../src/telegram/webpreview';

const MINT = '7RoRbGq7ncnmoqCsHRzDeaJz7zGcBwvtVaq2uaEfpump';
const POOL = 'HgpbxqtHN8uuntiPsmpMGzJUhYLFfpC1H24M5phdYomL';

const NOW = Date.parse('2026-08-10T20:00:00Z');
const POSTED = Date.parse('2026-08-10T18:00:00Z'); // two hours before we look

function tmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'pumpgod-shadow-')), 'store.json');
}

function post(over: Partial<PreviewPost> = {}): PreviewPost {
  return { handle: 'rival', id: 100, at: POSTED, text: `new one\n\n${MINT}`, ...over };
}

/**
 * Live market data as it stands *now* — two hours after they posted.
 *
 * Echoes back whichever address it was asked about, the way the real resolver does. A fake that
 * always answers with the same coin makes the tracker dedupe every post into one record, which
 * looks exactly like the pass having dropped them.
 */
function resolvedFor(address: string) {
  return {
    ok: true as const,
    query: address,
    call: {
      token: { address, kind: 'solana' as const, chain: 'solana' as const, origin: 'bare' as const, confidence: 0.6 },
      pairAddress: POOL,
      ticker: 'PATE',
      stats: { priceUsd: 0.004, marketCapUsd: 4_000_000 },
      candidates: [],
    },
  };
}

interface RunOptions {
  posts?: PreviewPost[];
  /** What the chart says the price was at their minute. `undefined` means it could not answer. */
  chartPrice?: number;
  maxNew?: number;
  maxAgeMs?: number;
  seen?: Watched;
  tracker?: Tracker;
  resolves?: boolean;
}

async function run(options: RunOptions = {}) {
  const tracker = options.tracker ?? new Tracker(tmp());
  const seen = options.seen ?? new Watched(tmp());
  const results = await shadowPass({
    handles: ['rival'],
    tracker,
    seen,
    now: () => NOW,
    paceMs: 0,
    maxNew: options.maxNew,
    maxAgeMs: options.maxAgeMs,
    fetchPosts: async () => options.posts ?? [post()],
    resolve: async (address: string) =>
      options.resolves === false ? { ok: false, reason: 'no pool' } : resolvedFor(address),
    entryPriceAt: async () => options.chartPrice,
  });
  return { tracker, seen, results, calls: tracker.list() };
}

/**
 * The claim this whole approach rests on: measuring a group needs no speed, because neither the
 * time nor the price comes off our clock. If either of these two tests goes red, a rival's score
 * has quietly become a measurement of our own polling delay.
 */
describe('a rival call is recorded as it was when they made it', () => {
  it('takes the time from their post, not from when we found it', async () => {
    const { calls } = await run();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.calledAt).toBe(POSTED);
    expect(calls[0]!.calledAt).not.toBe(NOW);
  });

  it('takes the entry price off the chart at that minute, not the price we see now', async () => {
    // They called it at 0.001. By the time we read the page it is at 0.004. Recording 0.004
    // would credit them with none of a 4x they actually called.
    const { calls } = await run({ chartPrice: 0.001 });
    expect(calls[0]!.entryPriceUsd).toBe(0.001);
    expect(calls[0]!.entryFromChart).toBe(true);
  });

  it('scales entry market cap from the entry price rather than sourcing it separately', async () => {
    // Supply is fixed, so one number derived from the other cannot contradict it. Two
    // independently sourced figures eventually will.
    const { calls } = await run({ chartPrice: 0.001 });
    expect(calls[0]!.entryMcUsd).toBeCloseTo(1_000_000, 6);
  });

  it('marks the record when the chart could not answer, rather than passing it off', async () => {
    const { calls } = await run({ chartPrice: undefined });
    expect(calls[0]!.entryPriceUsd).toBe(0.004);
    expect(calls[0]!.entryFromChart).toBeUndefined();
  });

  it('records the pool up front, so a call already past its window can still be settled', async () => {
    // A backfilled call retires on the very first pass, before any poll has run. `settle` needs
    // a pool to read the peak from; without one the record would hold no numbers at all.
    const { calls } = await run({ chartPrice: 0.001 });
    expect(calls[0]!.poolAddress).toBe(POOL);
  });
});

describe('what it is allowed to write', () => {
  it('only ever records shadow', async () => {
    const { calls } = await run();
    expect(calls[0]!.outcome).toBe('shadow');
  });

  it('files each channel under its own source, in its own namespace', async () => {
    const { calls } = await run();
    expect(calls[0]!.sourceId).toBe('tg:rival');
    // Distinct from anything the MTProto reader would write for the same group later. They are
    // two measurements taken by different means; averaged together they describe neither.
    expect(sourceIdFor('@Rival')).toBe('tg:rival');
  });
});

describe('what it passes over', () => {
  it('skips a victory lap and says so', async () => {
    const posts = [post({ id: 101, text: `88X $CATE HIT 85.5M now at 38.6M\n\n${MINT}` })];
    const { calls } = await run({ posts });
    expect(calls).toHaveLength(0);
  });

  it('skips a call whose window has mostly gone', async () => {
    const posts = [post({ id: 102, at: NOW - 20 * 60 * 60 * 1000 })];
    const { calls } = await run({ posts, maxAgeMs: 12 * 60 * 60 * 1000 });
    expect(calls).toHaveLength(0);
  });

  it('caps a cold start rather than recording twenty at once', async () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      post({ id: 200 + i, text: `one\n\n${MINT.slice(0, -2)}${i}${i}` }),
    );
    const { calls } = await run({ posts, maxNew: 3 });
    expect(calls).toHaveLength(3);
  });

  it('records nothing when the coin cannot be resolved', async () => {
    const { calls } = await run({ resolves: false });
    expect(calls).toHaveLength(0);
  });

  it('counts a channel reposting the same coin once, not twice', async () => {
    // Real: @ALSTEIN_GEMCLUB posted the same mint twice inside one window. The tracker keeps
    // the first either way, so the row was always right — but the pass reported two, and that
    // count is what the scorecard's twenty-call threshold is read against. Inflating it means
    // ranking a source before its sample is really there.
    const posts = [post({ id: 300 }), post({ id: 301, text: `again\n\n${MINT}` })];
    const { calls, results } = await run({ posts });
    expect(calls).toHaveLength(1);
    expect(results[0]!.recorded).toBe(1);
    expect(results[0]!.skipped.repost).toBe(1);
  });
});

describe('reading the same channel twice', () => {
  it('does not pay to re-resolve posts it has already considered', async () => {
    const tracker = new Tracker(tmp());
    const seen = new Watched(tmp());
    let resolves = 0;

    const pass = () =>
      shadowPass({
        handles: ['rival'],
        tracker,
        seen,
        now: () => NOW,
        paceMs: 0,
        fetchPosts: async () => [post({ id: 100 }), post({ id: 101, text: `two\n\n${MINT.slice(0, -1)}X` })],
        resolve: async (address: string) => {
          resolves += 1;
          return resolvedFor(address);
        },
        entryPriceAt: async () => 0.001,
      });

    await pass();
    expect(resolves).toBe(2);
    await pass();
    // The tracker would have deduped either way. This is about not spending two API round
    // trips per post per pass, eighty channels over, for answers already held.
    expect(resolves).toBe(2);
  });

  it('advances past posts it deliberately skipped, not just the ones it kept', async () => {
    const seen = new Watched(tmp());
    await run({ posts: [post({ id: 500, text: 'GM FAM' })], seen });
    expect(seen.lastId('rival')).toBe(500);
  });

  it('counts a channel that returns nothing, so a dead handle can be named', async () => {
    const seen = new Watched(tmp());
    const tracker = new Tracker(tmp());
    for (let i = 0; i < 3; i++) await run({ posts: [], seen, tracker });
    expect(seen.misses('rival')).toBe(3);
    // And a page that finally arrives is a cold start, not twenty brand-new calls.
    expect(seen.lastId('rival')).toBe(0);
  });
});
