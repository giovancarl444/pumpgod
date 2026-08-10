import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scoreboard } from '../src/track/stats';
import { renderScoreboard } from '../src/format/scoreboard';
import { Pinned, readPinned, type PinnedState } from '../src/social/pinned';
import type { TrackedCall } from '../src/track/tracker';
import type { Peer, SendResult, Transport } from '../src/telegram/transport';

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'a1',
    sourceId: 'manual',
    outcome: 'called',
    chain: 'solana',
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ticker: 'ZHAO',
    calledAt: Date.UTC(2026, 7, 9, 12),
    entryPriceUsd: 0.0001,
    entryMcUsd: 33_000,
    athPriceUsd: 0.0005,
    lastPriceUsd: 0.0003,
    ...over,
  };
}

interface Edit {
  peer: Peer;
  messageId: number;
  html: string;
}

function transport(outcome: 'ok' | 'fail' = 'ok') {
  const edits: Edit[] = [];
  const t: Transport = {
    kind: 'bot',
    resolve: async () => ({ id: 'x' }),
    send: async (): Promise<SendResult> => ({ dispatchAt: 0, ackAt: 1 }),
    edit: async (peer, messageId, html) => {
      if (outcome === 'fail') throw new Error('message to edit not found');
      edits.push({ peer, messageId, html });
    },
    sendPhoto: async () => ({ dispatchAt: 0, ackAt: 1 }),
    delete: async () => {},
  };
  return { transport: t, edits };
}

function pinned(state?: PinnedState) {
  const store = join(mkdtempSync(join(tmpdir(), 'pumpgod-')), 'scoreboard.json');
  if (state) writeFileSync(store, JSON.stringify(state));
  const board = new Pinned(store);
  board.load();
  return { board, store };
}

describe('what the record adds up to', () => {
  it('counts only calls we actually published', () => {
    const board = scoreboard([call(), call({ address: 'b', outcome: 'shadow' })]);
    expect(board.called).toBe(1);
  });

  it('keeps the calls it could not price out of the rate, and names them', () => {
    const board = scoreboard([call(), call({ address: 'b', athPriceUsd: undefined })]);
    expect(board.called).toBe(2);
    expect(board.priced).toBe(1);
    expect(board.unpriced).toBe(1);
  });

  // The peak of every call is at least 1x by construction, so a record built on peaks alone
  // can never show a loss. Where it stands now can, and that is the number worth publishing.
  it('picks the worst by where a call stands now, not by how high it got', () => {
    const board = scoreboard([
      call({ athPriceUsd: 0.0005, lastPriceUsd: 0.00002 }),
      call({ address: 'b', ticker: 'FLAT', athPriceUsd: 0.00011, lastPriceUsd: 0.0001 }),
    ]);
    // $ZHAO ran to 5x and gave it all back; $FLAT never moved. The bigger loss is $ZHAO.
    expect(board.worst).toMatchObject({ ticker: '$ZHAO' });
    expect(board.worst!.multiple).toBeCloseTo(0.2);
    expect(board.best).toMatchObject({ ticker: '$ZHAO' });
  });

  it('reports the typical call, not the average one', () => {
    const board = scoreboard([
      call({ athPriceUsd: 0.0001 }),
      call({ address: 'b', athPriceUsd: 0.0002 }),
      call({ address: 'c', athPriceUsd: 0.02 }),
    ]);
    // 1x, 2x and 200x: a mean says 67x, which describes none of them.
    expect(board.medianPeak).toBe(2);
  });

  it('counts rugs even where there is no price to judge', () => {
    const board = scoreboard([call({ athPriceUsd: undefined, rugged: true })]);
    expect(board.rugged).toBe(1);
    expect(board.unpriced).toBe(1);
  });
});

describe('the pinned message', () => {
  it('says nothing at all before there is anything to claim', () => {
    expect(renderScoreboard(scoreboard([]))).toBeUndefined();
    expect(renderScoreboard(scoreboard([call({ outcome: 'shadow' })]))).toBeUndefined();
  });

  it('publishes the denominator alongside the hits', () => {
    const text = renderScoreboard(scoreboard([call(), call({ address: 'b', athPriceUsd: 0.0001 })]))!;
    expect(text).toContain('<b>2</b> calls');
    expect(text).toContain('of 2 priced');
    expect(text).toContain('<b>1</b> hit 2x');
  });

  // The line no other group prints, and the reason the rest of them get believed.
  it('names the worst call, the rugs and the gaps', () => {
    const text = renderScoreboard(
      scoreboard([
        call({ lastPriceUsd: 0.00002 }),
        call({ address: 'b', rugged: true }),
        call({ address: 'c', athPriceUsd: undefined }),
      ]),
    )!;
    expect(text).toContain('worst · $ZHAO <b>0.20x</b>');
    expect(text).toContain('1 rugged');
    expect(text).toContain('1 we could not price');
  });

  it('ties the time to the milestone it belongs to', () => {
    const text = renderScoreboard(scoreboard([call({ athPriceUsd: 0.00124, timeTo2xSec: 95, timeTo10xSec: 1450 })]))!;
    expect(text).toContain('best · $ZHAO <b>12.4x</b> · 10x in 24m');
    expect(text).not.toContain('12.4x</b> · 2x');
  });
});

describe('keeping the pinned message current', () => {
  const state: PinnedState = { chatId: '-1002', messageId: 9, lastText: 'stale' };

  it('does nothing until one has been pinned', async () => {
    const { board } = pinned();
    const { transport: t, edits } = transport();
    await board.refresh(t, { id: '-1002' }, [call()]);
    expect(edits).toHaveLength(0);
  });

  it('edits the message that was pinned, in place', async () => {
    const { board } = pinned(state);
    const { transport: t, edits } = transport();
    await board.refresh(t, { id: '-1002' }, [call()]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.messageId).toBe(9);
    expect(edits[0]!.html).toContain('track record');
  });

  // Telegram rejects an edit that changes nothing, and the board only moves when a price
  // does — so without this the log fills with 400s for as long as the process runs.
  it('skips the edit when nothing has changed', async () => {
    const { board } = pinned(state);
    const { transport: t, edits } = transport();
    await board.refresh(t, { id: '-1002' }, [call()]);
    await board.refresh(t, { id: '-1002' }, [call()]);
    expect(edits).toHaveLength(1);
  });

  it('remembers what it sent across a restart', async () => {
    const { board, store } = pinned(state);
    const { transport: t } = transport();
    await board.refresh(t, { id: '-1002' }, [call()]);

    const again = new Pinned(store);
    again.load();
    const second = transport();
    await again.refresh(second.transport, { id: '-1002' }, [call()]);
    expect(second.edits).toHaveLength(0);
    expect(readPinned(store)!.lastText).toContain('track record');
  });

  // That id names a message in one chat. Editing the same number somewhere else rewrites
  // whatever happens to be there, which in a channel we administer is a real post.
  it('will not edit that message id in a different chat', async () => {
    const { board } = pinned(state);
    const { transport: t, edits } = transport();
    await board.refresh(t, { id: '-1009' }, [call()]);
    expect(edits).toHaveLength(0);
  });

  it('tries again after a failed edit rather than assuming it landed', async () => {
    const { board, store } = pinned(state);
    await board.refresh(transport('fail').transport, { id: '-1002' }, [call()]);
    expect(readPinned(store)!.lastText).toBe('stale');

    const { transport: t, edits } = transport();
    await board.refresh(t, { id: '-1002' }, [call()]);
    expect(edits).toHaveLength(1);
  });
});
