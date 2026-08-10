import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Api, TelegramClient, helpers } from 'telegram';
import { createCommandHandler } from '../src/pipeline/command';
import { Router } from '../src/pipeline/router';
import { AdminCheck } from '../src/telegram/admin';
import { attachIngest } from '../src/telegram/ingest';
import { peerIdOf } from '../src/telegram/client';
import { MtprotoTransport, mtprotoPeer } from '../src/telegram/mtproto';
import { journal } from '../src/store/journal';
import type { AppConfig } from '../src/config';

/**
 * The whole `/signal` path, from a raw Telegram update to a photo landing in the channel.
 *
 * Everything between is the real thing — ingest, the admin check, deleting the command,
 * resolving the market, the risk screen, routing, rendering, the upload. Only the two edges
 * are faked: the MTProto socket and the network. That is deliberate, because the bugs this is
 * here to catch live in the wiring between those pieces rather than inside any one of them,
 * and the wiring is what nobody can exercise without the account's credentials.
 */

const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';
const IMAGE = 'https://dd.dexscreener.com/ds-data/tokens/solana/bonk.png';

const big = (n: number) => BigInt(n) as unknown as bigInt.BigInteger;
const CHANNEL = new Api.InputPeerChannel({ channelId: big(555), accessHash: big(9) });
const WAR_ROOM = new Api.InputPeerChat({ chatId: big(777) });

function pair(over: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    pairAddress: POOL,
    priceUsd: '0.0000246',
    marketCap: 200_000,
    liquidity: { usd: 40_000 },
    volume: { h24: 90_000 },
    baseToken: { address: TOKEN, name: 'Bonk', symbol: 'bonk' },
    pairCreatedAt: Date.now() - 12 * 60_000,
    info: { imageUrl: IMAGE },
    ...over,
  };
}

interface Wire {
  /** Every request that reached the socket, in order. Ordering is part of what is asserted. */
  requests: unknown[];
  sent: Array<{ peer: Api.TypeInputPeer; text: string; photo: boolean }>;
  uploads: number;
}

/** The MTProto socket, reduced to the four calls this path can make. */
function wire(participant: Api.TypeChannelParticipant = adminRank): { client: TelegramClient; log: Wire } {
  const log: Wire = { requests: [], sent: [], uploads: 0 };
  let nextId = 500;

  const client = {
    addEventHandler: () => undefined,
    getInputEntity: async () => new Api.InputPeerUser({ userId: big(7), accessHash: big(0) }),
    uploadFile: async () => {
      log.uploads += 1;
      return new Api.InputFile({ id: helpers.generateRandomLong(), parts: 1, name: 'coin.png', md5Checksum: '' });
    },
    invoke: async (req: unknown) => {
      log.requests.push(req);
      if (req instanceof Api.messages.SendMessage || req instanceof Api.messages.SendMedia) {
        log.sent.push({
          peer: req.peer as Api.TypeInputPeer,
          text: req.message ?? '',
          photo: req instanceof Api.messages.SendMedia,
        });
        return { updates: [new Api.UpdateMessageID({ id: ++nextId, randomId: helpers.generateRandomLong() })] };
      }
      if (req instanceof Api.channels.GetParticipant) return { participant };
      return { updates: [] };
    },
  } as unknown as TelegramClient;

  return { client, log };
}

const adminRank = new Api.ChannelParticipantAdmin({
  userId: big(7),
  adminRights: new Api.ChatAdminRights({}),
  promotedBy: big(1),
  date: 0,
});
const memberRank = new Api.ChannelParticipant({ userId: big(7), date: 0 });

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    apiId: 1,
    apiHash: 'x',
    session: 'x',
    channel: 'chan',
    warRoom: 'war',
    live: true,
    showSource: false,
    dedupeTtlMs: 60_000,
    enrichEnabled: false,
    enrichTimeoutMs: 2000,
    footer: 'NFA · DYOR',
    metricsIntervalMs: 60_000,
    maxCallAgeSec: 90,
    catchupIntervalMs: 60_000,
    trackIntervalMs: 60_000,
    tradeUrlSol: 'https://axiom.trade/t/{address}',
    tradeUrlEvm: '',
    referralLabel: 'Trade these faster',
    chains: ['solana'],
    showImage: true,
    ...over,
  };
}

/**
 * Boots the same three objects `main` does and hands back the update handler ingest
 * registered — so a test pushes a Telegram update in, exactly as the running bot receives one.
 */
function bot(over: Partial<AppConfig> = {}, participant?: Api.TypeChannelParticipant) {
  const { client, log } = wire(participant);
  const cfg = config(over);
  const transport = new MtprotoTransport(client);
  const channelPeer = mtprotoPeer(CHANNEL);
  const warRoomPeer = cfg.warRoom ? mtprotoPeer(WAR_ROOM) : undefined;
  const router = new Router(transport, cfg, channelPeer, warRoomPeer, undefined);

  const settled: Array<Promise<void>> = [];
  const handleCommand = createCommandHandler({
    transport,
    config: cfg,
    router,
    admins: new AdminCheck(client, CHANNEL),
    channelPeer,
    warRoomPeer,
  });

  const onUpdate = attachIngest(
    client,
    new Map(),
    { channelId: peerIdOf(CHANNEL), warRoomId: peerIdOf(WAR_ROOM) },
    {
      onMessage: () => undefined,
      onReaction: () => undefined,
      onCommand: (cmd) => settled.push(handleCommand(cmd)),
    },
  );

  /** A post in the channel. `post: true` is what Telegram sets on a broadcast-channel message. */
  const type = async (text: string, from: 'channel' | 'warroom' = 'channel', over: Partial<Api.Message> = {}) => {
    const peerId = from === 'channel' ? new Api.PeerChannel({ channelId: big(555) }) : new Api.PeerChat({ chatId: big(777) });
    const message = new Api.Message({
      id: 42,
      peerId,
      message: text,
      date: Math.floor(Date.now() / 1000),
      post: from === 'channel',
      ...over,
    });
    onUpdate(new Api.UpdateNewChannelMessage({ message, pts: 0, ptsCount: 0 }));
    await Promise.all(settled);
    // `route` dispatches the publish without awaiting it, so the command resolving is not the
    // same thing as the card having been sent.
    await new Promise((r) => setTimeout(r, 20));
  };

  return { type, log };
}

/** Serves DexScreener and the image CDN. Anything unrouted 404s rather than hanging. */
function net(opts: { pairs?: unknown[]; image?: 'png' | 'html' | 'missing' } = {}) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      seen.push(url);
      if (url.includes('api.dexscreener.com')) {
        return { ok: true, json: async () => ({ pairs: opts.pairs ?? [pair()] }) } as Response;
      }
      if (opts.image === 'missing') return { ok: false, status: 404 } as Response;
      const type = opts.image === 'html' ? 'text/html' : 'image/png';
      return {
        ok: true,
        headers: new Headers({ 'content-type': type }),
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer,
      } as unknown as Response;
    }),
  );
  return seen;
}

beforeEach(() => journal.flush());
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/signal, from the update to the channel', () => {
  it('publishes the coin as a photo with the card as its caption', async () => {
    net();
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    expect(log.sent).toHaveLength(1);
    const card = log.sent[0]!;
    expect(card.peer).toBe(CHANNEL);
    expect(card.photo).toBe(true);
    expect(log.uploads).toBe(1);

    // The template the channel is meant to show, read back off the wire.
    expect(card.text).toContain('PUMPGOD');
    expect(card.text).toContain('Bonk | BONK');
    expect(card.text).toContain(TOKEN);
    expect(card.text).toContain('📊 Market Cap: $200K');
    expect(card.text).toContain('💧 Liquidity: $40K');
    expect(card.text).toContain('⏰ Token Age: 12m');
    expect(card.text).toContain('NFA · DYOR');
  });

  // The command is a message in the channel until we remove it. Publishing first would leave
  // members looking at the instruction sitting above the card.
  it('takes the command down before it posts anything', async () => {
    net();
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    const deleted = log.requests.findIndex((r) => r instanceof Api.channels.DeleteMessages);
    const posted = log.requests.findIndex((r) => r instanceof Api.messages.SendMedia);
    expect(deleted).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeLessThan(posted);
    expect((log.requests[deleted] as Api.channels.DeleteMessages).id).toEqual([42]);
  });

  // In a supergroup anyone can type. Nothing about the message says who may publish, so the
  // membership is what decides — and a member's command must not even delete itself.
  it('ignores the command from someone who is not an admin', async () => {
    net();
    const { type, log } = bot({}, memberRank);
    await type(`/signal ${TOKEN}`, 'channel', { post: false, fromId: new Api.PeerUser({ userId: big(7) }) });

    expect(log.sent).toHaveLength(0);
    expect(log.requests.some((r) => r instanceof Api.channels.DeleteMessages)).toBe(false);
  });

  // A call without artwork is a call. A call that never goes out because a CDN was slow is a
  // miss, and a miss is the one failure that cannot be recovered from.
  it('still posts the call when the artwork cannot be fetched', async () => {
    net({ image: 'missing' });
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.photo).toBe(false);
    expect(log.sent[0]!.text).toContain(TOKEN);
    expect(log.uploads).toBe(0);
  });

  // The command deleted itself on the way in, so an unanswered refusal is indistinguishable
  // from a bot that has died — and the admin is standing there waiting for one or the other.
  it('says why in the war room when the coin has no market', async () => {
    net({ pairs: [] });
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.peer).toBe(WAR_ROOM);
    expect(log.sent[0]!.text).toContain('no pool found');
  });

  it('refuses an address on a chain we do not call, and says so', async () => {
    const seen = net();
    const { type, log } = bot();
    await type('/signal 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90');

    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.peer).toBe(WAR_ROOM);
    expect(log.sent[0]!.text).toContain('only calling solana');
    // Base58 and 0x cannot be the same chain, so the shape settles it with no round trip.
    expect(seen).toHaveLength(0);
  });

  // An admin who typed the address has already decided, so the screen marks the card rather
  // than swallowing the call. The warning it raises is repeated in the war room and nowhere
  // else — members can read the flag on the card itself.
  it('publishes a coin the screen objects to, marking the card and telling the war room', async () => {
    net({ pairs: [pair({ liquidity: { usd: 900 } })] });
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    const card = log.sent.find((s) => s.peer === CHANNEL);
    expect(card?.text).toContain('cannot exit size');

    const warning = log.sent.find((s) => s.peer === WAR_ROOM);
    expect(warning?.text).toContain('published anyway');
    expect(warning?.text).toContain('cannot exit size');
  });

  // The whole point of the exemption: it must not need a war room to work.
  it('publishes a flagged coin with no war room configured at all', async () => {
    net({ pairs: [pair({ liquidity: { usd: 900 } })] });
    const { type, log } = bot({ warRoom: undefined });
    await type(`/signal ${TOKEN}`);

    expect(log.sent).toHaveLength(1);
    expect(log.sent[0]!.peer).toBe(CHANNEL);
    expect(log.sent[0]!.text).toContain('cannot exit size');
  });

  // DexScreener answers `liquidity: null` on a pool it has no depth reading for. Every
  // liquidity check needs that number, so the screen used to return a clean verdict on the
  // token it knew least about — and the card drops its liquidity line rather than showing a
  // zero, leaving nothing anywhere to say we could not check.
  it('marks a coin whose depth the market will not report, rather than calling it clear', async () => {
    net({ pairs: [pair({ liquidity: null })] });
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);

    const card = log.sent.find((s) => s.peer === CHANNEL);
    expect(card?.text).toContain('depth unknown');
    expect(card?.text).not.toContain('💧 Liquidity');
  });

  it('does not publish when LIVE is false, and says that is why', async () => {
    net();
    const { type, log } = bot({ live: false });
    await type(`/signal ${TOKEN}`);

    expect(log.sent.filter((s) => s.peer === CHANNEL)).toHaveLength(0);
    expect(log.sent[0]!.text).toContain('LIVE=false');
  });

  // Our own card comes back through ingest as a message in the channel. If it parsed as a
  // command the channel would call itself forever.
  it('does not treat the card it just posted as a new command', async () => {
    net();
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`);
    const published = log.sent[0]!.text;

    log.sent.length = 0;
    await type(published);
    expect(log.sent).toHaveLength(0);
  });

  // The war room is a private chat you chose, so it needs no rights check — which is the one
  // way to call a coin when the channel is a broadcast you post to from a phone.
  it('accepts the command from the war room without an admin lookup', async () => {
    net();
    const { type, log } = bot();
    await type(`/signal ${TOKEN}`, 'warroom');

    expect(log.sent.some((s) => s.peer === CHANNEL && s.photo)).toBe(true);
    expect(log.requests.some((r) => r instanceof Api.channels.GetParticipant)).toBe(false);
    expect(log.requests.some((r) => r instanceof Api.channels.DeleteMessages)).toBe(false);
  });
});
