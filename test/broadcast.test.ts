import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Broadcast } from '../src/social/broadcast';
import type { Peer, SendOptions, Transport } from '../src/telegram/transport';
import type { Outcome, TrackedCall } from '../src/track/tracker';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = 1_700_000_000_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'broadcast-'));
});

function store(): string {
  return join(dir, 'broadcast.json');
}

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    sourceId: 'manual',
    chain: 'solana',
    address: `addr-${Math.random()}`,
    ticker: 'TROLL',
    outcome: 'called' as Outcome,
    calledAt: T0,
    entryPriceUsd: 1,
    athPriceUsd: 3,
    lastPriceUsd: 2,
    ...over,
  } as TrackedCall;
}

/** A clock the test drives, since every rule in this file is about elapsed time. */
function at(t: { now: number }) {
  return () => t.now;
}

function sent(): { transport: Transport; texts: string[]; fail: () => void } {
  const texts: string[] = [];
  let broken = false;
  const transport = {
    kind: 'bot',
    async send(_peer: Peer, text: string) {
      if (broken) throw new Error('telegram said no');
      texts.push(text);
      return { messageId: 1 };
    },
  } as unknown as Transport;
  return { transport, texts, fail: () => { broken = true; } };
}

const PEER: Peer = { id: '-100123' } as Peer;

describe('the agent speaking without being spoken to', () => {
  it('says nothing at all while the flag is off', () => {
    const clock = { now: T0 };
    const b = new Broadcast({ enabled: false, store: store(), now: at(clock) });
    b.load();
    clock.now = T0 + 10 * DAY;
    expect(b.due([call()])).toBeUndefined();
  });

  /**
   * The daemon runs with `LIVE=true` against the real channel and restarts on every source
   * edit. If "never posted" counted as overdue, switching the flag on would post immediately —
   * most likely while somebody is still deciding whether switching it on was safe.
   */
  it('starts the clock rather than firing the moment it is switched on', () => {
    const clock = { now: T0 };
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();
    expect(b.due([call()])).toBeUndefined();

    clock.now = T0 + DAY;
    expect(b.due([call({ calledAt: clock.now - HOUR })])).toContain('Last 24h');
  });

  it('counts the interval from the last post, not from process start', () => {
    const clock = { now: T0 };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 - HOUR }));

    // Eleven restarts in an evening must not be eleven digests: each one re-reads the same
    // mark off disk and finds it is still an hour old.
    for (let i = 0; i < 11; i++) {
      const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
      b.load();
      expect(b.due([call()])).toBeUndefined();
    }
  });

  it('publishes nothing for a day it made no calls', () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    // Called, but a week ago — outside the window the digest describes.
    expect(b.due([call({ calledAt: T0 - 7 * DAY })])).toBeUndefined();
  });

  /**
   * The single gate. A shadow row is a rival's call and a member pick is a stranger's; either
   * one appearing in a digest is us claiming a call we never made, in the channel, in writing.
   */
  it('never counts a call we did not publish', () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    const others = [
      call({ calledAt: clock.now - HOUR, outcome: 'shadow' as Outcome }),
      call({ calledAt: clock.now - HOUR, outcome: 'member' as Outcome }),
      call({ calledAt: clock.now - HOUR, outcome: 'dry-run' as Outcome }),
    ];
    expect(b.due(others)).toBeUndefined();
  });

  it('names the worst call in the same breath as the best', () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    const text = b.due([
      call({ calledAt: clock.now - HOUR, ticker: 'WIN', entryPriceUsd: 1, athPriceUsd: 8, lastPriceUsd: 6 }),
      call({ calledAt: clock.now - HOUR, ticker: 'LOSS', entryPriceUsd: 1, athPriceUsd: 1.1, lastPriceUsd: 0.2 }),
    ]);

    expect(text).toContain('$WIN');
    expect(text).toContain('$LOSS');
    expect(text).toContain('0.20x');
  });

  it('holds the clock when the send fails, so the day is not silently skipped', async () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    const { transport, fail } = sent();
    fail();
    await b.run(transport, PEER, [call({ calledAt: clock.now - HOUR })]);

    expect(JSON.parse(readFileSync(store(), 'utf8')).lastAt).toBe(T0);
  });

  it('moves the clock on once it has actually posted', async () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    const { transport, texts } = sent();
    const calls = [call({ calledAt: clock.now - HOUR })];
    await b.run(transport, PEER, calls);
    expect(texts).toHaveLength(1);

    // And immediately again: the same pass must not post twice.
    await b.run(transport, PEER, calls);
    expect(texts).toHaveLength(1);
    expect(JSON.parse(readFileSync(store(), 'utf8')).lastAt).toBe(clock.now);
  });

  it('does not ping everyone for a routine receipt', async () => {
    const clock = { now: T0 + DAY };
    writeFileSync(store(), JSON.stringify({ lastAt: T0 }));
    const b = new Broadcast({ enabled: true, store: store(), now: at(clock) });
    b.load();

    const send = vi.fn(async (_peer: Peer, _text: string, opts?: SendOptions) => {
      void opts;
      return { messageId: 1 };
    });
    await b.run({ kind: 'bot', send } as unknown as Transport, PEER, [call({ calledAt: clock.now - HOUR })]);
    expect(send.mock.calls[0]?.[2]).toMatchObject({ silent: true });
  });
});
