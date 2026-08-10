import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, CompetitionConfig } from '../src/config';
import { renderLeaderboard, renderStanding } from '../src/format/leaderboard';
import { createMemberHandlers, memberSourceId } from '../src/pipeline/member';
import { Members } from '../src/store/members';
import type { DirectMessage } from '../src/telegram/botingest';
import { scoreboard } from '../src/track/stats';
import { Tracker, type TrackedCall } from '../src/track/tracker';

/**
 * The competition is the one place where people who are not us put coins into our machine.
 * So the tests that matter are the containment ones — that a pick is measured and never
 * published, that it cannot merge with a call of our own, and that nobody wins the table by
 * submitting more often than everyone else.
 */

let dir: string;

const COIN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

const PAIR = {
  chainId: 'solana',
  pairAddress: 'PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  baseToken: { address: COIN, name: 'Zhao', symbol: 'ZHAO' },
  priceUsd: '0.001',
  marketCap: 400_000,
  liquidity: { usd: 90_000 },
  volume: { h24: 250_000 },
  pairCreatedAt: Date.now() - 6 * 60 * 60 * 1000,
};

function market(pair: unknown | null = PAIR) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ pairs: pair ? [pair] : [] }) }) as Response),
  );
}

function config(over: Partial<AppConfig> = {}): AppConfig {
  return { enrichTimeoutMs: 2000, chains: ['solana'], ...over } as AppConfig;
}

const COMP: CompetitionConfig = { enabled: true, picksPerDay: 1, minSample: 5, size: 10 };

function handlers(over: Partial<CompetitionConfig> = {}) {
  const tracker = new Tracker(join(dir, 'tracked.json'));
  const members = new Members(join(dir, 'members.json'));
  const h = createMemberHandlers({
    config: config(),
    competition: { ...COMP, ...over },
    tracker,
    members,
  });
  return { ...h, tracker, members };
}

function dm(text: string, over: Partial<DirectMessage> = {}): DirectMessage {
  return { text, chatId: '77', messageId: 1, fromId: '77', handle: '@alice', recvAt: 0, ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'member-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('entering a pick', () => {
  it('records it under the member, not under us', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`), COIN);

    const tracked = h.tracker.list();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ sourceId: memberSourceId('77'), outcome: 'member' });
  });

  /**
   * The gate everything else rests on. A member's pick reaching the public feed would put an
   * unvetted coin under our name, and there is no way to un-publish a call.
   */
  it('can never be counted as one of our calls', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`), COIN);

    expect(scoreboard(h.tracker.list()).called).toBe(0);
  });

  it('cannot be promoted into a call by a later route', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`), COIN);
    const pick = h.tracker.list()[0]!;

    // Whatever else happens to this record — a bug, a rewrite, a shared code path — the
    // outcome sits above `called` in the rank, so it cannot climb into it.
    h.tracker.track(signalFor(pick), 'called');
    expect(h.tracker.list()[0]!.outcome).toBe('member');
  });

  it('keeps its own entry price when we call the same coin', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`), COIN);
    h.tracker.track(signalFor(h.tracker.list()[0]!, 'manual'), 'called');

    // Two rows, not one: which of us was earlier to it is the only interesting question, and
    // a merged record cannot answer it.
    expect(h.tracker.list()).toHaveLength(2);
    expect(h.tracker.list().map((c) => c.outcome).sort()).toEqual(['called', 'member']);
  });

  it('takes one pick a day and says when the next one is', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`), COIN);
    const second = await h.submit(dm(`/submit ${OTHER}`), OTHER);

    expect(second).toContain('used your pick');
    expect(h.tracker.list()).toHaveLength(1);
  });

  it('refuses a coin the member already holds, rather than eating the pick', async () => {
    market();
    const h = handlers({ picksPerDay: 5 });
    await h.submit(dm(`/submit ${COIN}`), COIN);
    const again = await h.submit(dm(`/submit ${COIN}`), COIN);

    expect(again).toContain('already have');
    // The tracker would have silently merged it, so the pick would have cost them nothing.
    expect(h.members.pickedSince('77', Date.now(), 24 * 60 * 60 * 1000)).toBe(1);
  });

  it('spends nothing on an address that does not resolve', async () => {
    market(null);
    const h = handlers();
    const answer = await h.submit(dm(`/submit ${COIN}`), COIN);

    expect(answer).toContain('✗');
    expect(h.tracker.list()).toHaveLength(0);
    expect(h.members.pickedSince('77', Date.now(), 24 * 60 * 60 * 1000)).toBe(0);
  });

  it('stays shut when the competition is off, which is the default', async () => {
    market();
    const h = handlers({ enabled: false });
    const answer = await h.submit(dm(`/submit ${COIN}`), COIN);

    expect(answer).toContain('not running');
    expect(h.tracker.list()).toHaveLength(0);
  });

  /**
   * `handleOf` gives a `@username` when there is one and Telegram's `first_name` when there is
   * not — and a first name is free text the member picks. Storing it would put a string of
   * their choosing on a table we render as HTML in the channel.
   */
  it('keeps a username and refuses a display name', async () => {
    market();
    const h = handlers();
    await h.submit(dm(`/submit ${COIN}`, { fromId: '88', handle: '<b>alice</b>' }), COIN);

    expect(h.members.find('88')?.handle).toBeUndefined();
  });
});

describe('the table', () => {
  /**
   * Members with known peaks per pick, so the ranking is asserted rather than guessed at.
   * `1` is break-even, so `[3, 3, 3]` is a member whose typical pick tripled.
   */
  function board(peaksByMember: Record<string, number[]>, over: Partial<CompetitionConfig> = {}) {
    const h = handlers(over);
    const all: TrackedCall[] = Object.entries(peaksByMember).flatMap(([memberId, peaks]) =>
      peaks.map(
        (peak, i): TrackedCall => ({
          id: `${memberId}-${i}`,
          sourceId: memberSourceId(memberId),
          outcome: 'member',
          chain: 'solana',
          address: `${memberId}addr${i}`,
          ticker: `T${i}`,
          calledAt: Date.now() - 1000,
          entryPriceUsd: 1,
          athPriceUsd: peak,
          lastPriceUsd: peak,
        }),
      ),
    );

    vi.spyOn(h.tracker, 'list').mockReturnValue(all);
    return h;
  }

  it('ranks on the median, so one lucky pick does not own the table forever', () => {
    const h = board({ lucky: [50, 0.1, 0.1], steady: [3, 3, 3] }, { minSample: 3 });
    const table = h.leaderboard();

    expect(table[0]!.memberId).toBe('steady');
    expect(table[0]!.medianPeak).toBe(3);
    // The 50x is still on their record — it is simply not what they are ranked on.
    expect(table[1]!.best?.multiple).toBe(50);
  });

  it('sorts anyone under the sample to the bottom, however good they look', () => {
    const h = board({ thin: [100, 100], deep: [2, 2, 2, 2, 2] }, { minSample: 5 });
    const table = h.leaderboard();

    expect(table[0]!.memberId).toBe('deep');
    expect(table[1]!.memberId).toBe('thin');
  });

  it('names the unranked as still qualifying rather than hiding them', () => {
    const h = board({ thin: [100, 100] }, { minSample: 5 });
    const html = renderLeaderboard(h.leaderboard(), { ...COMP, minSample: 5 });

    expect(html).toContain('still qualifying');
    expect(html).toContain('2/5');
    expect(html).toContain('nobody is ranked');
  });

  it('says so when nobody has entered, instead of showing an empty table', () => {
    expect(renderLeaderboard([], COMP)).toContain('Nobody has entered yet');
  });

  it('shows a member their worst pick as well as their best', () => {
    const h = board({ '77': [8, 1.5, 0.4] }, { minSample: 1 });
    const html = renderStanding(h.standingFor('77'), { ...COMP, minSample: 1 }, 1);

    expect(html).toContain('best · $T0 <b>8.00x</b>');
    expect(html).toContain('worst · $T2 <b>0.40x</b>');
    expect(html).toContain('#1');
  });

  it('tells a member with no picks how to make one', () => {
    expect(renderStanding(undefined, COMP)).toContain('/submit');
  });

  it('cannot be given an HTML name by the person it is about', () => {
    const h = board({ '77': [2, 2] }, { minSample: 1 });
    h.members.upsert('77', '<b>pwn</b>');
    const html = renderLeaderboard(h.leaderboard(), { ...COMP, minSample: 1 });

    expect(html).not.toContain('<b>pwn</b>');
  });

  it('shows an id rather than a blank where a member has no username', () => {
    const h = board({ '4455667788': [2, 2] }, { minSample: 1 });
    expect(renderLeaderboard(h.leaderboard(), { ...COMP, minSample: 1 })).toContain('member 7788');
  });
});

function signalFor(call: TrackedCall, sourceId = call.sourceId) {
  return {
    id: call.id,
    source: { id: sourceId, label: sourceId, mode: 'auto' as const, enabled: true },
    chatId: '1',
    messageId: 1,
    rawText: '',
    call: {
      token: {
        address: call.address,
        kind: 'solana' as const,
        chain: call.chain,
        origin: 'labelled' as const,
        confidence: 1,
      },
      stats: {},
      candidates: [],
    },
    confirmations: [],
    ageSec: 0,
    stale: false,
    risk: { level: 'clear' as const, flags: [] },
    timings: { messageUnix: 0, recvAt: 0, wallClockMs: Date.now() },
  };
}
