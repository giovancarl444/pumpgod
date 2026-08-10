import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrackedCall, Outcome } from '../src/track/tracker';
import { dailyRecap, milestonePost, reached, summarise, duration } from '../src/social/recap';
import { Poster } from '../src/social/poster';
import { tweetLength, TWEET_LIMIT } from '../src/social/x';

const OPTS = { channelUrl: 'https://t.me/pumpgod_fun', minMultiple: 5, dailyRecap: true };

const CREDS = { apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'a' };

/** A Poster that writes its history to a throwaway file — never the operator's real one. */
function poster(over: Partial<typeof OPTS> = {}) {
  const storePath = join(mkdtempSync(join(tmpdir(), 'pumpgod-')), 'posted.json');
  return new Poster({ ...OPTS, ...over, storePath }, CREDS);
}

/** Stubs the X endpoint, recording every tweet body it is handed. */
function x(outcome: 'ok' | 'fail') {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body).text as string);
    return outcome === 'ok'
      ? { ok: true, status: 200, json: async () => ({ data: { id: '1' } }) }
      : { ok: false, status: 500, json: async () => ({ detail: 'upstream is down' }) };
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'a1',
    sourceId: 'manual',
    outcome: 'called',
    chain: 'solana',
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ticker: 'ZHAO',
    calledAt: Date.now(),
    entryPriceUsd: 0.0001,
    entryMcUsd: 33_000,
    athPriceUsd: 0.0005,
    timeTo2xSec: 120,
    timeTo5xSec: 360,
    ...over,
  };
}

describe('only calls we actually made', () => {
  // The public channel is a timestamped record anyone can check a post against. Claiming a
  // call we never published is the one mistake that cannot be walked back.
  const notOurs: Outcome[] = ['shadow', 'dry-run', 'staged'];

  for (const outcome of notOurs) {
    it(`never posts a ${outcome} call`, () => {
      expect(milestonePost(call({ outcome }), 5, OPTS)).toBeUndefined();
      expect(new Poster(OPTS).due([call({ outcome })])).toHaveLength(0);
    });
  }

  it('leaves them out of the daily scoreboard too', () => {
    const day = new Date();
    const mixed = [call(), call({ outcome: 'shadow', athPriceUsd: 0.01 })];
    expect(summarise(mixed).called).toBe(1);
    expect(dailyRecap(mixed, day, OPTS)).toContain('1 call');
  });
});

describe('milestonePost', () => {
  it('states the multiple, the entry and how long it took', () => {
    const text = milestonePost(call(), 5, OPTS)!;
    expect(text).toContain('$ZHAO did 5x');
    expect(text).toContain('$33K');
    expect(text).toContain('$165K');
    expect(text).toContain('6m');
    expect(text).toContain('https://t.me/pumpgod_fun');
  });

  it("multiplies out, so the post's own numbers cannot be picked apart", () => {
    const text = milestonePost(call({ entryMcUsd: 40_000 }), 5, OPTS)!;
    expect(text).toContain('$40K → $200K');
  });

  it('will not claim a milestone the call never reached', () => {
    expect(milestonePost(call({ athPriceUsd: 0.0003 }), 5, OPTS)).toBeUndefined();
  });

  it('says nothing when there is no price history to say it from', () => {
    expect(milestonePost(call({ entryPriceUsd: undefined, athPriceUsd: undefined }), 5, OPTS)).toBeUndefined();
  });

  it('fits in a tweet even with a long name and a big run', () => {
    const text = milestonePost(
      call({ ticker: 'SUPERLONGTICKERNAME', entryMcUsd: 1_234_567, athPriceUsd: 0.01 }),
      100,
      OPTS,
    )!;
    expect(tweetLength(text)).toBeLessThanOrEqual(TWEET_LIMIT);
  });
});

describe('reached', () => {
  it('lists milestones best-first and respects the floor', () => {
    // 12x peak: 10 and 5 qualify, 2 is below the floor and is noise.
    expect(reached(call({ athPriceUsd: 0.0012 }), 5)).toEqual([10, 5]);
  });

  it('returns nothing when the run is below the floor', () => {
    expect(reached(call({ athPriceUsd: 0.0003 }), 5)).toEqual([]);
  });
});

describe('Poster', () => {
  it('posts only the best milestone, not every one it passed', () => {
    const posts = new Poster(OPTS).due([call({ athPriceUsd: 0.0012 })]);
    const milestones = posts.filter((p) => p.key.includes('x')).map((p) => p.key);
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toContain('10x');
  });

  it('keys a milestone to the coin, so a restart cannot repeat it', () => {
    const poster = new Poster(OPTS);
    const [first] = poster.due([call()]);
    const [second] = new Poster(OPTS).due([call()]);
    expect(first!.key).toBe(second!.key);
  });

  it('says nothing at all when no call cleared the floor', () => {
    expect(new Poster({ ...OPTS, dailyRecap: false }).due([call({ athPriceUsd: 0.00015 })])).toHaveLength(0);
  });

  it('tries again after a post fails, rather than counting it as said', async () => {
    // A failed send that still marks the milestone loses the call silently — the one
    // outcome worse than posting twice, because nothing in the log says it went missing.
    const p = poster({ dailyRecap: false });
    const calls = [call()];

    x('fail');
    await p.run(calls);
    expect(p.due(calls)).toHaveLength(1);

    const sent = x('ok');
    await p.run(calls);
    expect(sent).toHaveLength(1);
    expect(p.due(calls)).toHaveLength(0);
  });

  it('does not follow a 10x with the 5x it passed on the way', async () => {
    const p = poster({ dailyRecap: false });
    const calls = [call({ athPriceUsd: 0.0012 })];

    const sent = x('ok');
    await p.run(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('10x');

    await p.run(calls);
    expect(sent).toHaveLength(1);
  });
});

describe('dailyRecap', () => {
  it('gives the denominator, not just the winners', () => {
    const calls = [call(), call({ address: 'b', athPriceUsd: 0.0001 }), call({ address: 'c', athPriceUsd: 0.0001 })];
    const text = dailyRecap(calls, new Date('2026-08-09'), OPTS)!;
    expect(text).toContain('3 calls');
    expect(text).toContain('1 × 5x');
  });

  it('does not pin the 2x time on the peak multiple', () => {
    // 12.4x peak, but the only fast leg was the 2x at 95s. Reporting "12.4x in 2m" is the
    // kind of claim anyone can disprove from the chart, and it discredits the honest ones.
    const runner = call({ athPriceUsd: 0.00124, timeTo2xSec: 95, timeTo5xSec: 380, timeTo10xSec: 1450 });
    const text = dailyRecap([runner], new Date('2026-08-09'), OPTS)!;
    expect(text).toContain('best $ZHAO 12.4x · 10x in 24m');
    expect(text).not.toContain('12.4x in 2m');
  });

  it('admits a flat day rather than skipping it', () => {
    const text = dailyRecap([call({ athPriceUsd: 0.0001 })], new Date('2026-08-09'), OPTS)!;
    expect(text).toContain('none ran');
  });

  it('says nothing on a day with no calls', () => {
    expect(dailyRecap([], new Date(), OPTS)).toBeUndefined();
  });

  it('files it under the day it reports on, not the UTC day', () => {
    // The suite runs at TZ=Asia/Tokyo (see package.json) precisely so this is meaningful:
    // the window is local midnight to local midnight, so the key must be local too. Taken
    // from UTC instead, a machine east of the line files the small hours under yesterday's
    // date — and then posts that day all over again tomorrow.
    const justAfterMidnight = new Date(2026, 7, 10, 0, 30);
    const yesterday = new Date(2026, 7, 9, 12, 0);

    const posts = poster().due([call({ calledAt: yesterday.getTime() })], justAfterMidnight);
    const recap = posts.find((p) => p.key.startsWith('daily:'));
    expect(recap!.key).toBe('daily:2026-08-09');
    expect(recap!.text).toContain('9 Aug');
  });
});

describe('tweetLength', () => {
  it('counts a link as 23 characters however long it is', () => {
    // X shortens every URL to the same width; measuring the raw string over-rejects posts.
    const long = `x https://dexscreener.com/solana/${'a'.repeat(80)}`;
    expect(tweetLength(long)).toBe(2 + 23);
  });
});

describe('duration', () => {
  it('reads the way a person would say it', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(360)).toBe('6m');
    expect(duration(4500)).toBe('1h 15m');
    expect(duration(7200)).toBe('2h');
  });
});
