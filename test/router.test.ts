import { describe, expect, it, beforeEach } from 'vitest';
import { Api, TelegramClient, helpers } from 'telegram';
import { Router } from '../src/pipeline/router';
import type { AppConfig } from '../src/config';
import type { Source } from '../src/types';
import type { IncomingMessage } from '../src/telegram/ingest';
import { journal } from '../src/store/journal';

const CHANNEL = new Api.InputPeerSelf();
const WAR_ROOM = new Api.InputPeerSelf();

interface Sent {
  peer: Api.TypeInputPeer;
  text: string;
  id: number;
}

function harness(overrides: Partial<AppConfig> = {}) {
  const sent: Sent[] = [];
  const edits: Array<{ id: number; text: string }> = [];
  let nextId = 100;

  const client = {
    invoke: async (req: unknown) => {
      if (req instanceof Api.messages.SendMessage) {
        const id = ++nextId;
        sent.push({ peer: req.peer, text: req.message, id });
        return { updates: [new Api.UpdateMessageID({ id, randomId: helpers.generateRandomLong() })] };
      }
      if (req instanceof Api.messages.EditMessage) {
        edits.push({ id: req.id, text: req.message });
        return { updates: [] };
      }
      return { updates: [] };
    },
  } as unknown as TelegramClient;

  const config: AppConfig = {
    apiId: 1,
    apiHash: 'x',
    session: 'x',
    channel: 'chan',
    warRoom: 'war',
    live: true,
    showSource: false,
    dedupeTtlMs: 60_000,
    // Enrichment would reach out to DexScreener; the flow under test is everything before that.
    enrichEnabled: false,
    enrichTimeoutMs: 100,
    footer: 'NFA · DYOR',
    metricsIntervalMs: 60_000,
    ...overrides,
  };

  return { router: new Router(client, config, CHANNEL, WAR_ROOM), sent, edits };
}

function source(mode: Source['mode'], extra: Partial<Source> = {}): Source {
  return { id: 'soaps', label: 'Soaps Gems', mode, enabled: true, ...extra };
}

const CALL_TEXT =
  'Troll in Hood | TROLL\nCA: 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90\n📊 Market Cap: $36.27K 🌐 Robinhood Chain 💧 Liquidity: $16.91K';

function incoming(src: Source, text = CALL_TEXT, messageId = 1): IncomingMessage {
  return {
    source: src,
    chatId: '777',
    messageId,
    text,
    messageUnix: Math.floor(Date.now() / 1000),
    recvAt: performance.now(),
    isEdit: false,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => journal.flush());

describe('Router', () => {
  it('auto sources publish straight to the channel', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('auto')));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(CHANNEL);
    expect(sent[0]!.text).toContain('PUMPGOD CALL');
    expect(sent[0]!.text).toContain('0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90');
  });

  it('review sources stage to the war room and publish only after a 🚀', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('review')));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(WAR_ROOM);

    router.handleReaction({ chatId: 'war', messageId: sent[0]!.id, emoji: '🚀', recvAt: performance.now() });
    await settle();

    expect(sent).toHaveLength(2);
    expect(sent[1]!.peer).toBe(CHANNEL);
  });

  it('a 👎 kills the call and a later 🚀 cannot revive it', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('review')));
    await settle();

    router.handleReaction({ chatId: 'war', messageId: sent[0]!.id, emoji: '👎', recvAt: performance.now() });
    router.handleReaction({ chatId: 'war', messageId: sent[0]!.id, emoji: '🚀', recvAt: performance.now() });
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('reacting twice cannot double-post', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('review')));
    await settle();

    const id = sent[0]!.id;
    router.handleReaction({ chatId: 'war', messageId: id, emoji: '🚀', recvAt: performance.now() });
    router.handleReaction({ chatId: 'war', messageId: id, emoji: '🔥', recvAt: performance.now() });
    await settle();

    expect(sent).toHaveLength(2);
  });

  it('shadow sources never surface anywhere', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('shadow')));
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('LIVE=false publishes nothing even on an auto source', async () => {
    const { router, sent } = harness({ live: false });
    router.handleMessage(incoming(source('auto')));
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('the same contract from a second group does not double-post', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('auto')));
    await settle();
    router.handleMessage(incoming(source('auto', { id: 'other', label: 'Other Group' }), CALL_TEXT, 2));
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('respects the market cap window', async () => {
    const { router, sent } = harness();
    // The call reports $36.27K, below this floor.
    router.handleMessage(incoming(source('auto', { minMarketCapUsd: 100_000 })));
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('respects the chain allowlist', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('auto', { chains: ['solana'] })));
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('ignores ordinary chatter', async () => {
    const { router, sent } = harness();
    router.handleMessage(incoming(source('auto'), 'gm what are we buying today'));
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('ignores a reaction on a message it never staged', async () => {
    const { router, sent } = harness();
    router.handleReaction({ chatId: 'war', messageId: 999, emoji: '🚀', recvAt: performance.now() });
    await settle();
    expect(sent).toHaveLength(0);
  });
});
