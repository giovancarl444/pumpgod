import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig, CompetitionConfig } from '../src/config';
import { createMemberHandlers, memberSourceId } from '../src/pipeline/member';
import { PickAlerts } from '../src/social/alerts';
import { Members } from '../src/store/members';
import type { Peer, SendOptions, SendResult, Transport } from '../src/telegram/transport';
import { Tracker, type TrackedCall } from '../src/track/tracker';

/**
 * A member's pick is the one thing in the tracker that is somebody else's, so the tests that
 * matter are the containment ones. Everything here either proves a message reaches the person
 * who made the pick, or proves it reaches nowhere else — least of all the channel.
 */

const COMP: CompetitionConfig = { enabled: true, picksPerDay: 1, minSample: 5, size: 10 };
const CHANNEL = '-1002000000000';
const COIN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'pumpgod-'));
}

/**
 * The real leaderboard, not a stand-in. A position asserted in here is then the position the
 * pinned table would print for the same picks — which is the whole point of a member being
 * told one at all.
 */
function board(dir: string, comp: CompetitionConfig) {
  return createMemberHandlers({
    config: { enrichTimeoutMs: 2000, chains: ['solana'] } as AppConfig,
    competition: comp,
    tracker: new Tracker(join(dir, 'tracked.json')),
    members: new Members(join(dir, 'members.json')),
  });
}

/** Writes its history to a throwaway file — never the operator's real one. */
function alerts(over: { comp?: CompetitionConfig; storePath?: string } = {}) {
  const comp = over.comp ?? COMP;
  const dir = tmp();
  return new PickAlerts(board(dir, comp), comp, { storePath: over.storePath ?? join(dir, 'alerted.json') });
}

interface Sent {
  peer: Peer;
  html: string;
  opts: SendOptions;
}

/** Records what reached Telegram, and can be told to fail the way a real send does. */
function transport(fail?: string) {
  const sent: Sent[] = [];
  const t: Transport = {
    kind: 'bot',
    resolve: async () => ({ id: 'x' }),
    send: async (peer, html, opts = {}): Promise<SendResult> => {
      if (fail) throw new Error(fail);
      sent.push({ peer, html, opts });
      return { messageId: sent.length, dispatchAt: 0, ackAt: 1 };
    },
    edit: async () => {},
    sendPhoto: async () => ({ dispatchAt: 0, ackAt: 1 }),
    delete: async () => {},
  };
  return { transport: t, sent };
}

function pick(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'p1',
    sourceId: memberSourceId('4242'),
    outcome: 'member',
    chain: 'solana',
    address: COIN,
    ticker: 'ZHAO',
    calledAt: Date.now() - 600_000,
    entryPriceUsd: 0.0001,
    entryMcUsd: 33_000,
    athPriceUsd: 0.0002,
    ...over,
  };
}

/** `count` priced picks for one member, all at the same peak, so the median is predictable. */
function picks(memberId: string, count: number, peak: number): TrackedCall[] {
  return Array.from({ length: count }, (_, i) =>
    pick({
      id: `${memberId}-${i}`,
      sourceId: memberSourceId(memberId),
      address: `${COIN.slice(0, 40)}${i}${memberId.slice(-2)}`,
      athPriceUsd: 0.0001 * peak,
    }),
  );
}

describe('what earns a member a message', () => {
  it('says nothing until the pick has actually done something', () => {
    expect(alerts().due([pick({ athPriceUsd: 0.00015 })])).toHaveLength(0);
  });

  it('tells them about a 2x, which is the whole reason they came back', () => {
    const [due] = alerts().due([pick()]);
    expect(due).toBeDefined();
    expect(due!.text).toContain('Your pick $ZHAO hit 2x');
  });

  // The retirement pass reads the true high off the chart, which can move a peak one last time
  // hours after the fact. That correction belongs in the score, not in a notification.
  it('does not announce a run that finished yesterday', () => {
    expect(alerts().due([pick({ athPriceUsd: 0.001, retired: true })])).toHaveLength(0);
  });
});

describe('nothing here can reach the channel', () => {
  it('ignores a call we published ourselves', () => {
    expect(alerts().due([pick({ outcome: 'called', sourceId: 'manual' })])).toHaveLength(0);
  });

  it('ignores every other kind of tracked call', () => {
    for (const outcome of ['shadow', 'staged', 'dry-run', 'promo', 'duplicate'] as const) {
      expect(alerts().due([pick({ outcome, sourceId: 'somebody-else' })])).toHaveLength(0);
    }
  });

  // The destination is read out of the record's own `member:<id>` source id, so a stray channel
  // id sitting on the record — which is exactly what a bug would leave there — changes nothing.
  it('sends to the member, not to wherever the record has been', () => {
    const [due] = alerts().due([pick({ postChatId: CHANNEL, postMessageId: 5, postThreadId: 291 })]);
    expect(due!.peer.id).toBe('4242');
    expect(due!.peer.threadId).toBeUndefined();
  });

  it('drops a member record whose source id it cannot read', () => {
    expect(alerts().due([pick({ sourceId: 'member' })])).toHaveLength(0);
  });
});

describe('what the message says', () => {
  it('multiplies the entry out rather than quoting a peak that may disagree with it', () => {
    const [due] = alerts().due([pick()]);
    expect(due!.text).toContain('$33K → $66K');
  });

  // Time-since-called overstates the run after a restart, which is precisely when the recorded
  // crossing is the only number that is still true.
  it('prefers the time it recorded for the crossing over the time since the pick', () => {
    const [due] = alerts().due([pick({ timeTo2xSec: 95 })]);
    expect(due!.text).toContain('in 2m');
    expect(due!.text).not.toContain('in 10m');
  });

  it('falls back to how long the pick has been alive where no crossing was timed', () => {
    const [due] = alerts().due([pick({ athPriceUsd: 0.0025 })]);
    expect(due!.text).toContain('hit 25x');
    expect(due!.text).toContain('in 10m');
  });

  // A symbol is free text chosen by whoever deployed the coin, and this is sent as HTML.
  it('will not let a coin write markup into a member DM', () => {
    const [due] = alerts().due([pick({ ticker: '<a href="https://evil.example">X</a>' })]);
    expect(due!.text).not.toContain('<a href');
    expect(due!.text).toContain('&lt;a href');
  });
});

describe('where it tells them they stand', () => {
  it('gives a ranked member their position on the table', () => {
    const all = [...picks('1', 5, 3), ...picks('2', 5, 10)];
    const due = alerts().due(all);
    const mine = due.find((a) => a.peer.id === '1');
    // Two members are ranked and the 10x median is above the 3x one, so member 1 is second.
    expect(mine!.text).toContain('You are <b>#2</b> of 2 on the leaderboard');
  });

  // The nudge, at the one moment they are most likely to take it.
  it('tells an unranked member what is left rather than a meaningless position', () => {
    const [due] = alerts().due([pick()]);
    expect(due!.text).toContain('<b>4</b> more priced picks and you are on the table');
    expect(due!.text).not.toContain('leaderboard');
  });

  it('counts down in the singular on the last one', () => {
    const due = alerts().due(picks('4242', 4, 3));
    expect(due[0]!.text).toContain('<b>1</b> more priced pick and you are on the table');
  });
});

describe('saying each thing once', () => {
  it('does not repeat a milestone on the next sweep', async () => {
    const { transport: t, sent } = transport();
    const a = alerts();
    await a.run(t, [pick()]);
    await a.run(t, [pick()]);
    expect(sent).toHaveLength(1);
  });

  it('settles the smaller milestones a bigger one spoke for', async () => {
    const { transport: t, sent } = transport();
    const a = alerts();
    await a.run(t, [pick({ athPriceUsd: 0.001 })]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('hit 10x');

    // Falling back to 5x afterwards must not produce a second, smaller announcement.
    await a.run(t, [pick({ athPriceUsd: 0.001 })]);
    expect(sent).toHaveLength(1);
  });

  // Two members holding the same token is the normal case, and a key scoped to the coin alone
  // would mean whichever of them we processed second never hearing about their own pick.
  it('tells both members when they picked the same coin', async () => {
    const { transport: t, sent } = transport();
    await alerts().run(t, [
      pick({ id: 'a', sourceId: memberSourceId('1') }),
      pick({ id: 'b', sourceId: memberSourceId('2') }),
    ]);
    expect(sent.map((s) => s.peer.id).sort()).toEqual(['1', '2']);
  });

  it('carries its history across a restart', async () => {
    const storePath = join(tmp(), 'alerted.json');
    const { transport: t, sent } = transport();

    await alerts({ storePath }).run(t, [pick()]);
    expect(sent).toHaveLength(1);

    const restarted = alerts({ storePath });
    restarted.load();
    await restarted.run(t, [pick()]);
    expect(sent).toHaveLength(1);
  });
});

describe('when the message will not go', () => {
  it('tries again after a send that failed for a reason that might pass', async () => {
    const a = alerts();
    await a.run(transport('Bad Gateway').transport, [pick()]);

    const { transport: t, sent } = transport();
    await a.run(t, [pick()]);
    expect(sent).toHaveLength(1);
  });

  // Otherwise one member who blocked the bot is a warning every minute for a day, and the real
  // failure underneath it is never seen.
  it('gives up on a member who cannot be messaged at all', async () => {
    const a = alerts();
    await a.run(transport('Forbidden: bot was blocked by the user').transport, [pick()]);

    const { transport: t, sent } = transport();
    await a.run(t, [pick()]);
    expect(sent).toHaveLength(0);
  });
});
