import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Followups } from '../src/social/followup';
import type { TrackedCall } from '../src/track/tracker';
import type { Peer, SendOptions, SendResult, Transport } from '../src/telegram/transport';

/** A Followups that writes its history to a throwaway file — never the operator's real one. */
function followups() {
  const storePath = join(mkdtempSync(join(tmpdir(), 'pumpgod-')), 'followed.json');
  return new Followups({ storePath });
}

interface Sent {
  peer: Peer;
  html: string;
  opts: SendOptions;
}

/** Records what reached Telegram, and can be told to fail the way a real send does. */
function transport(outcome: 'ok' | 'fail' = 'ok') {
  const sent: Sent[] = [];
  const t: Transport = {
    kind: 'bot',
    resolve: async () => ({ id: 'x' }),
    send: async (peer, html, opts = {}): Promise<SendResult> => {
      if (outcome === 'fail') throw new Error('message to reply not found');
      sent.push({ peer, html, opts });
      return { messageId: sent.length, dispatchAt: 0, ackAt: 1 };
    },
    edit: async () => {},
    sendPhoto: async () => ({ dispatchAt: 0, ackAt: 1 }),
    delete: async () => {},
  };
  return { transport: t, sent };
}

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'a1',
    sourceId: 'manual',
    outcome: 'called',
    chain: 'solana',
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    ticker: 'ZHAO',
    calledAt: Date.now() - 600_000,
    entryPriceUsd: 0.0001,
    entryMcUsd: 33_000,
    athPriceUsd: 0.0002,
    postChatId: '-1002',
    postMessageId: 77,
    ...over,
  };
}

describe('answering a call under its own card', () => {
  it('replies to the message the call went out in', () => {
    const [due] = followups().due([call({ postThreadId: 4 })]);
    expect(due).toBeDefined();
    expect(due!.replyTo).toBe(77);
    expect(due!.peer).toEqual({ id: '-1002', threadId: 4 });
    expect(due!.milestone).toBe(2);
  });

  // The whole point of the reply is that the entry price is one scroll away. Without a card
  // to hang it under, the same text is a claim about a call the reader cannot find.
  it('stays quiet about a call whose card we never recorded', () => {
    expect(followups().due([call({ postMessageId: undefined })])).toHaveLength(0);
    expect(followups().due([call({ postChatId: undefined })])).toHaveLength(0);
  });

  it('never announces a call we did not publish', () => {
    expect(followups().due([call({ outcome: 'shadow' })])).toHaveLength(0);
    expect(followups().due([call({ outcome: 'staged' })])).toHaveLength(0);
  });

  it('says nothing until a call has actually done something', () => {
    expect(followups().due([call({ athPriceUsd: 0.00015 })])).toHaveLength(0);
  });

  it('names the coin, the multiple and where it came from', () => {
    const [due] = followups().due([call()]);
    expect(due!.text).toContain('$ZHAO 2x');
    expect(due!.text).toContain('$33K → $66K');
    expect(due!.text).toContain('in 10m');
  });

  // A symbol is free text the deployer chose, and this reply goes into the public channel as
  // HTML. `tokenText` takes the brackets out on the way in, but a record tracked before it did
  // still carries them — and an unescaped `<` also fails the send outright, which would mean a
  // coin that can silence its own milestone.
  it('will not let a coin write markup into the channel', () => {
    const [due] = followups().due([call({ ticker: '<a href="https://evil.example">X</a>' })]);
    expect(due!.text).not.toContain('<a href');
    expect(due!.text).toContain('&lt;a href');
  });
});

describe('saying each thing once', () => {
  it('does not repeat a milestone on the next sweep', async () => {
    const f = followups();
    const { transport: t, sent } = transport();

    await f.run(t, [call()]);
    await f.run(t, [call()]);

    expect(sent).toHaveLength(1);
  });

  // A coin that ran to 10x between two polls reached 2x and 5x on the way. Announcing all
  // three would read as three separate calls, and the two smaller ones are already old news.
  it('settles the smaller milestones a bigger one spoke for', async () => {
    const f = followups();
    const { transport: t, sent } = transport();

    await f.run(t, [call({ athPriceUsd: 0.001 })]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain('10x');

    // The same call, still at its peak: nothing left to say about it.
    await f.run(t, [call({ athPriceUsd: 0.001 })]);
    expect(sent).toHaveLength(1);
  });

  // Marking it sent before it lands would lose the milestone outright. A run is worth
  // mentioning late.
  it('tries again after a send that failed', async () => {
    const f = followups();
    await f.run(transport('fail').transport, [call()]);

    const { transport: t, sent } = transport();
    await f.run(t, [call()]);
    expect(sent).toHaveLength(1);
  });

  it('carries its history across a restart', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'pumpgod-')), 'followed.json');
    const { transport: t, sent } = transport();

    await new Followups({ storePath }).run(t, [call()]);

    const restarted = new Followups({ storePath });
    restarted.load();
    await restarted.run(t, [call()]);

    expect(sent).toHaveLength(1);
  });
});

describe('who gets a notification', () => {
  it('lets a 2x land quietly', async () => {
    const { transport: t, sent } = transport();
    await followups().run(t, [call()]);
    expect(sent[0]!.opts.silent).toBe(true);
  });

  // Ten times the money is worth a phone buzzing. Two is not, and treating it as though it
  // were is how a channel teaches people to mute it.
  it('buzzes for a 10x', async () => {
    const { transport: t, sent } = transport();
    await followups().run(t, [call({ athPriceUsd: 0.001 })]);
    expect(sent[0]!.opts.silent).toBe(false);
  });
});
