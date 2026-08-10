import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CompetitionConfig } from '../src/config';
import { PickAlerts, type Board } from '../src/social/alerts';
import { Followups } from '../src/social/followup';
import { Poster } from '../src/social/poster';
import { dailyRecap, milestonePost } from '../src/social/recap';
import { isPublished, scoreboard } from '../src/track/stats';
import type { Outcome, TrackedCall } from '../src/track/tracker';

/**
 * `isPublished()` is the single gate between what we measured and what we claim.
 *
 * Everything the tracker holds sits in one store: our own calls, coins we watched and passed on,
 * adverts somebody paid for, and picks belonging to members of the channel. Only the first of
 * those is ours to take credit for. A bug here does not produce a wrong number — it produces a
 * stranger's coin in the public feed with our name above it, which is the one failure this
 * product cannot survive, because the entire pitch is that our record is checkable.
 *
 * So the gate gets a test of its own rather than being covered incidentally by whichever surface
 * happened to be under test. Every published surface is asked the same question here, because
 * the guarantee is worth exactly as much as its leakiest reader.
 */

/**
 * Every outcome, and whether it may be claimed in public.
 *
 * A `Record<Outcome, …>` on purpose: adding a case to the union without answering this question
 * stops the suite compiling, and that is the only reminder that arrives before the mistake does.
 */
const PUBLIC: Record<Outcome, boolean> = {
  called: true,
  staged: false,
  shadow: false,
  'dry-run': false,
  duplicate: false,
  promo: false,
  member: false,
};

const OUTCOMES = Object.keys(PUBLIC) as Outcome[];

const RECAP = { minMultiple: 5, channelUrl: 'https://t.me/pumpgod' };
const COMP: CompetitionConfig = { enabled: true, picksPerDay: 1, minSample: 5, size: 10 };

function store(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'pumpgod-')), name);
}

/** A 10x with its card recorded — so every surface below would fire, if the gate let it. */
function call(outcome: Outcome): TrackedCall {
  return {
    id: 'a1',
    sourceId: outcome === 'member' ? 'member:4242' : 'manual',
    outcome,
    chain: 'solana',
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ticker: 'ZHAO',
    calledAt: Date.now() - 600_000,
    entryPriceUsd: 0.0001,
    entryMcUsd: 33_000,
    athPriceUsd: 0.001,
    lastPriceUsd: 0.001,
    timeTo10xSec: 600,
    postChatId: '-1002',
    postMessageId: 77,
  };
}

/** Every reader that puts a number somewhere other people can see it. */
const surfaces: Array<{ what: string; claims(call: TrackedCall): boolean }> = [
  {
    what: 'the pinned track record',
    claims: (c) => scoreboard([c]).called > 0,
  },
  {
    what: 'a milestone post on X',
    claims: (c) => milestonePost(c, 10, RECAP) !== undefined,
  },
  {
    what: "the day's recap on X",
    claims: (c) => dailyRecap([c], new Date(), RECAP) !== undefined,
  },
  {
    what: 'the X feed',
    claims: (c) => new Poster({ ...RECAP, dailyRecap: false, storePath: store('posted.json') }).due([c]).length > 0,
  },
  {
    what: 'a milestone reply in the channel',
    claims: (c) => new Followups({ storePath: store('followed.json') }).due([c]).length > 0,
  },
];

describe('the one gate on everything we claim', () => {
  it('admits our own published calls and nothing else', () => {
    for (const outcome of OUTCOMES) {
      expect(isPublished(call(outcome)), outcome).toBe(PUBLIC[outcome]);
    }
  });

  for (const surface of surfaces) {
    it(`keeps everything we did not publish out of ${surface.what}`, () => {
      for (const outcome of OUTCOMES) {
        expect(surface.claims(call(outcome)), outcome).toBe(PUBLIC[outcome]);
      }
    });
  }
});

describe('the one reader that is deliberately the other way round', () => {
  const board: Board = { leaderboard: () => [] };
  const alerts = () => new PickAlerts(board, COMP, { storePath: store('alerted.json') });

  // A member's pick is the only thing here that earns a message *because* it was never
  // published — so its gate is the mirror image, and has to be exactly as narrow.
  it('messages a member about a pick, and about nothing else in the store', () => {
    for (const outcome of OUTCOMES) {
      expect(alerts().due([call(outcome)]).length > 0, outcome).toBe(outcome === 'member');
    }
  });

  // Which only holds while the destination comes out of the record. A pick carries the same
  // `postChatId` fields as anything else, and none of them are read.
  it('reads the destination off the pick, never off where a card once went', () => {
    const [due] = alerts().due([call('member')]);
    expect(due!.peer.id).toBe('4242');
  });
});
