import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Api, TelegramClient, helpers } from 'telegram';
import { Router } from '../src/pipeline/router';
import type { AppConfig } from '../src/config';
import type { ParsedCall, Source } from '../src/types';
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
        sent.push({ peer: req.peer as Api.TypeInputPeer, text: req.message ?? '', id });
        return { updates: [new Api.UpdateMessageID({ id, randomId: helpers.generateRandomLong() })] };
      }
      if (req instanceof Api.messages.EditMessage) {
        edits.push({ id: req.id, text: req.message ?? '' });
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
    maxCallAgeSec: 90,
    catchupIntervalMs: 60_000,
    trackIntervalMs: 60_000,
    tradeUrlSol: 'https://axiom.trade/t/{address}',
    tradeUrlEvm: '',
    referralLabel: 'Trade these faster',
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

const MANUAL_ADDRESS = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

/** What `resolveManualCall` hands the router: an address plus live market data. */
function manualCall(stats: Partial<ParsedCall['stats']> = {}): ParsedCall {
  const token: ParsedCall['token'] = {
    address: MANUAL_ADDRESS,
    kind: 'solana',
    chain: 'solana',
    origin: 'labelled',
    confidence: 1,
  };
  return {
    token,
    pairAddress: 'EP2ib6dYdEeqD8MfE2ezHCxX3kP3K2eLKkirfPm5eyMx',
    name: 'dogwifhat',
    ticker: 'WIF',
    stats: { marketCapUsd: 300_000, liquidityUsd: 60_000, volumeUsd: 120_000, ...stats },
    candidates: [token],
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
    expect(sent[0]!.text).toContain('PUMPGOD');
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

  it('a recovered call is too old to auto-fire and goes to review instead', async () => {
    const { router, sent } = harness();
    const old = incoming(source('auto'));
    old.messageUnix = Math.floor(Date.now() / 1000) - 600;

    router.handleMessage(old);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(WAR_ROOM);
    expect(sent[0]!.text).toContain('NOT fresh');
  });

  it('still auto-fires a call that is merely a few seconds old', async () => {
    const { router, sent } = harness();
    const recent = incoming(source('auto'));
    recent.messageUnix = Math.floor(Date.now() / 1000) - 5;

    router.handleMessage(recent);
    await settle();

    expect(sent[0]!.peer).toBe(CHANNEL);
  });

  it('holds back an untradable call even from an auto source', async () => {
    const { router, sent } = harness();
    // $2M market cap standing on a $9K pool — the chart is real, the exit is not.
    const unbacked =
      'Rugpull Inc | RUG\nCA: 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90\n📊 Market Cap: $2.00M 💧 Liquidity: $9.00K';

    router.handleMessage(incoming(source('auto'), unbacked));
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(WAR_ROOM);
    expect(sent[0]!.text).toContain('HELD BACK');
  });

  it('a coin we call ourselves goes straight to the channel', async () => {
    const { router, sent } = harness();
    router.callManual(manualCall(), `call ${MANUAL_ADDRESS}`, performance.now());
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(CHANNEL);
    expect(sent[0]!.text).toContain('PUMPGOD');
    expect(sent[0]!.text).toContain('WIF');
  });

  it('does not re-fetch market data it already has', async () => {
    // Manual calls resolve before publishing, so the post-publish enrich pass would be a
    // second round trip that could only overwrite fresher numbers with the same ones.
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ pairs: [] }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const { router, sent, edits } = harness({ enrichEnabled: true });
    router.callManual(manualCall(), 'call x', performance.now());
    await settle();

    expect(sent).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(edits).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('holds back a coin we call ourselves if it cannot be exited', async () => {
    const { router, sent } = harness();
    router.callManual(
      manualCall({ marketCapUsd: 2_000_000, liquidityUsd: 9_000 }),
      'call x',
      performance.now(),
    );
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.peer).toBe(WAR_ROOM);
    expect(sent[0]!.text).toContain('HELD BACK');
  });

  it('will not call the same coin twice', async () => {
    const { router, sent } = harness();
    router.callManual(manualCall(), 'call x', performance.now());
    await settle();
    router.callManual(manualCall(), 'call x', performance.now());
    await settle();

    expect(sent).toHaveLength(1);
  });

  it('ignores a reaction on a message it never staged', async () => {
    const { router, sent } = harness();
    router.handleReaction({ chatId: 'war', messageId: 999, emoji: '🚀', recvAt: performance.now() });
    await settle();
    expect(sent).toHaveLength(0);
  });
});
