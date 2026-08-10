import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, PromoConfig } from '../src/config';
import { renderPromo } from '../src/format/promo';
import { createPromoHandlers, PROMO_SOURCE_ID, type PromoHandlers } from '../src/pipeline/promo';
import { Promos } from '../src/store/promos';
import { BotApi } from '../src/telegram/botapi';
import { Tracker } from '../src/track/tracker';
import { scoreboard } from '../src/track/stats';
import type { DirectMessage, PaidOrder, PreCheckout } from '../src/telegram/botingest';
import type { Peer, PhotoOptions, SendOptions, SendResult, Transport } from '../src/telegram/transport';
import type { ParsedCall } from '../src/types';

/**
 * Selling a slot is the only path in the project that takes somebody's money, so the tests
 * that matter are the ones about money and about contamination: that nothing is charged for a
 * coin we would refuse, that a payment we cannot deliver is given back, and that a bought card
 * can never reach the track record the channel is built on.
 */

let dir: string;
let calls: Array<{ method: string; params: Record<string, unknown> }>;
let sent: Array<{ html: string; opts: SendOptions }>;

const CHANNEL: Peer = { id: '-100999' };

/** A coin that resolves and passes the screen. `fetch` is stubbed to hand this back. */
const GOOD = {
  chainId: 'solana',
  pairAddress: 'PooLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  baseToken: { address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', name: 'Zhao', symbol: 'ZHAO' },
  priceUsd: '0.001',
  marketCap: 400_000,
  liquidity: { usd: 90_000 },
  volume: { h24: 250_000 },
  pairCreatedAt: Date.now() - 6 * 60 * 60 * 1000,
};

/** The same coin with the liquidity drained — what the screen exists to refuse. */
const HONEYPOT = { ...GOOD, marketCap: 9_000_000, liquidity: { usd: 300 }, volume: { h24: 20 } };

function market(pair: unknown | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url.includes('api.telegram.org')) {
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        calls.push({ method: url.slice(url.lastIndexOf('/') + 1), params: body });
        return { json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
      }
      return { ok: true, json: async () => ({ pairs: pair ? [pair] : [] }) } as Response;
    }),
  );
}

const transport: Transport = {
  kind: 'bot',
  resolve: async () => CHANNEL,
  send: async (_peer: Peer, html: string, opts: SendOptions = {}): Promise<SendResult> => {
    sent.push({ html, opts });
    return { messageId: 42, dispatchAt: 0, ackAt: 1 };
  },
  sendPhoto: async (_peer: Peer, _url: string, html: string, opts: PhotoOptions = {}): Promise<SendResult> => {
    sent.push({ html, opts });
    return { messageId: 42, dispatchAt: 0, ackAt: 1 };
  },
  edit: async () => undefined,
  delete: async () => undefined,
};

function config(over: Partial<AppConfig> = {}): AppConfig {
  return {
    live: true,
    showSource: false,
    footer: '',
    enrichEnabled: false,
    enrichTimeoutMs: 2000,
    maxCallAgeSec: 90,
    chains: ['solana'],
    showImage: false,
    tradeUrlSol: 'https://axiom.trade/t/{address}',
    tradeUrlEvm: '',
    referralLabel: 'Trade these faster',
    apiId: 1,
    apiHash: 'x',
    session: '',
    botToken: '123:SECRET',
    channel: 'chan',
    dedupeTtlMs: 60_000,
    metricsIntervalMs: 60_000,
    catchupIntervalMs: 60_000,
    trackIntervalMs: 60_000,
    ...over,
  } as AppConfig;
}

const PROMO: PromoConfig = { enabled: true, priceStars: 1000, dailyLimit: 3 };

function handlers(over: { promo?: Partial<PromoConfig>; config?: Partial<AppConfig> } = {}) {
  const promos = new Promos(join(dir, 'promos.json'));
  const tracker = new Tracker(join(dir, 'tracked.json'));
  const deps = {
    api: new BotApi('123:SECRET'),
    transport,
    config: config(over.config),
    promo: { ...PROMO, ...over.promo },
    channelPeer: CHANNEL,
    tracker,
    promos,
  };
  return { ...createPromoHandlers(deps), promos, tracker };
}

function dm(text: string): DirectMessage {
  return { text, chatId: '555', messageId: 1, fromId: '555', handle: '@buyer', recvAt: 0 };
}

const COIN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

/**
 * `/promote <address>` as it arrives here — the DM router has already taken the verb off the
 * front, so the handler is handed both the message and the argument. Which spellings of the
 * command reach it at all is `direct.test.ts`'s question, not this file's.
 */
function promote(onPromote: PromoHandlers['onPromote'], address = COIN) {
  return onPromote(dm(`/promote ${address}`), address);
}

function paid(payload: string): PaidOrder {
  return {
    chatId: '555',
    fromId: '555',
    payload,
    amount: 1000,
    currency: 'XTR',
    chargeId: 'charge_1',
    recvAt: 0,
  };
}

function checkout(payload: string, over: Partial<PreCheckout> = {}): PreCheckout {
  return { id: 'q1', fromId: '555', payload, amount: 1000, currency: 'XTR', ...over };
}

/** What the bot said back to the buyer, which is the only thing they experience. */
function replies(): string[] {
  return calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));
}

function invoices() {
  return calls.filter((c) => c.method === 'sendInvoice');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'promo-'));
  calls = [];
  sent = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('quoting a slot', () => {
  it('invoices in Stars, which is the only currency a bot may charge in', async () => {
    market(GOOD);
    const { onPromote, promos } = handlers();
    await promote(onPromote);

    const invoice = invoices()[0]!;
    expect(invoice.params.currency).toBe('XTR');
    expect(invoice.params.prices).toEqual([{ label: '$ZHAO promotion', amount: 1000 }]);
    // The payload is the order, so a receipt names what it paid for without a lookup table.
    expect(promos.find(String(invoice.params.payload))).toMatchObject({ state: 'invoiced', stars: 1000 });
  });

  // The whole ordering of this feature. Screening after payment would make the refund path
  // the normal way a bad coin is turned away, and would put us in an argument every time.
  it('refuses a coin the screen rejects before charging anything', async () => {
    market(HONEYPOT);
    const { onPromote } = handlers();
    await promote(onPromote);

    expect(invoices()).toHaveLength(0);
    expect(replies()[0]).toContain('Nothing has been charged');
  });

  it('charges nothing for an address that does not resolve', async () => {
    market(null);
    const { onPromote } = handlers();
    await promote(onPromote);

    expect(invoices()).toHaveLength(0);
    expect(replies()[0]).toContain('✗');
  });

  it('stays shut when promotion is switched off, which is the default', async () => {
    market(GOOD);
    const { onPromote } = handlers({ promo: { enabled: false } });
    await promote(onPromote);

    expect(invoices()).toHaveLength(0);
    expect(replies()[0]).toContain('not open');
  });

  // Taking money for a post that cannot go out is the one failure worth pre-empting entirely.
  it('will not sell a slot in a channel it is not publishing to', async () => {
    market(GOOD);
    const { onPromote } = handlers({ config: { live: false } });
    await promote(onPromote);

    expect(invoices()).toHaveLength(0);
  });

  it('does not open a second invoice for a coin already waiting to be paid for', async () => {
    market(GOOD);
    const { onPromote } = handlers();
    await promote(onPromote);
    await promote(onPromote);

    expect(invoices()).toHaveLength(1);
    expect(replies().at(-1)).toContain('already have an unpaid invoice');
  });

  /**
   * Telegram caps an invoice title at 32 characters and refuses the whole call over it.
   *
   * So an over-long symbol does not produce a cramped invoice, it produces no invoice at all —
   * and the buyer is told only that something failed, gets the same failure every time they
   * try again, and never learns why. The person promoting a coin they launched themselves is
   * exactly the customer who has a symbol like this, which makes it the wrong sale to lose.
   */
  it('still sells a slot for a coin whose symbol is too long for a Telegram invoice', async () => {
    market({ ...GOOD, baseToken: { ...GOOD.baseToken, symbol: 'MAXIMUM'.repeat(6) } });
    const { onPromote } = handlers();
    await promote(onPromote);

    const invoice = invoices()[0];
    expect(invoice, 'the sale was lost over the width of a name').toBeDefined();
    expect(String(invoice!.params.title).length).toBeLessThanOrEqual(32);
    expect(String(invoice!.params.title)).toContain('Promote $MAXIMUM');
  });

  // Cut on a character boundary, never through one. Half a surrogate pair is not valid text,
  // and Telegram would refuse the request for that instead — the same lost sale, wearing a
  // different error. Memecoin symbols are full of emoji, so this is the ordinary case.
  it('cuts a symbol full of emoji without splitting one in half', async () => {
    market({ ...GOOD, baseToken: { ...GOOD.baseToken, symbol: '🚀'.repeat(30) } });
    const { onPromote } = handlers();
    await promote(onPromote);

    const title = String(invoices()[0]!.params.title);
    expect(title.length).toBeLessThanOrEqual(32);
    // A lone surrogate is what slicing mid-character leaves behind.
    expect(/[\uD800-\uDFFF]/.test(title.replace(/\p{Emoji_Presentation}/gu, ''))).toBe(false);
    expect(title).toContain('🚀');
  });
});

describe('taking the payment', () => {
  it('approves a checkout for an open order at the price we set', async () => {
    market(GOOD);
    const { onPromote, onPreCheckout } = handlers();
    await promote(onPromote);
    const payload = String(invoices()[0]!.params.payload);

    await onPreCheckout(checkout(payload));
    const answer = calls.find((c) => c.method === 'answerPreCheckoutQuery')!;
    expect(answer.params.ok).toBe(true);
  });

  it('refuses a checkout for an order it has never heard of', async () => {
    market(GOOD);
    const { onPreCheckout } = handlers();
    await onPreCheckout(checkout('not-an-order'));

    expect(calls.find((c) => c.method === 'answerPreCheckoutQuery')!.params.ok).toBe(false);
  });

  // Cannot arise from Telegram's own invoice, which is exactly why accepting it would be
  // accepting a price we did not set.
  it('refuses a checkout whose amount is not the one invoiced', async () => {
    market(GOOD);
    const { onPromote, onPreCheckout } = handlers();
    await promote(onPromote);
    const payload = String(invoices()[0]!.params.payload);

    await onPreCheckout(checkout(payload, { amount: 1 }));
    expect(calls.find((c) => c.method === 'answerPreCheckoutQuery')!.params.ok).toBe(false);
  });
});

describe('delivering it', () => {
  async function buy(h = handlers()) {
    market(GOOD);
    await promote(h.onPromote);
    const payload = String(invoices()[0]!.params.payload);
    await h.onPaid(paid(payload));
    return { ...h, payload };
  }

  it('posts the card and marks the order delivered', async () => {
    const { promos, payload } = await buy();

    expect(sent).toHaveLength(1);
    expect(promos.find(payload)).toMatchObject({ state: 'posted' });
  });

  // Disclosure is what separates this from the structure regulators treat as fraud, and it is
  // also what stops a bought card being mistaken for one of ours.
  it('labels the card as paid and disowns the pick, in the card itself', async () => {
    await buy();

    const { html } = sent[0]!;
    expect(html).toContain('PAID PROMOTION');
    expect(html).toContain('did not choose this coin');
    // The channel's own header must never appear on something somebody bought.
    expect(html).not.toContain('PUMPGOD</b> ⚡');
  });

  it('gives the Stars back when the card cannot be posted', async () => {
    market(GOOD);
    const h = handlers();
    await promote(h.onPromote);
    const payload = String(invoices()[0]!.params.payload);

    vi.spyOn(transport, 'send').mockRejectedValueOnce(new Error('chat not found'));
    await h.onPaid(paid(payload));

    expect(calls.some((c) => c.method === 'refundStarPayment')).toBe(true);
    expect(h.promos.find(payload)).toMatchObject({ state: 'refunded' });
    expect(replies().at(-1)).toContain('refunded');
  });

  it('refunds money that arrives with no order behind it', async () => {
    market(GOOD);
    const { onPaid } = handlers();
    await onPaid(paid('nothing-here'));

    expect(calls.some((c) => c.method === 'refundStarPayment')).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('stops selling once the day is full', async () => {
    const h = await buy();
    // The cap counts what was posted, so this needs a delivered order behind it.
    expect(h.promos.postedSince(Date.now(), 24 * 60 * 60 * 1000)).toBe(1);

    const capped = handlers({ promo: { dailyLimit: 1 } });
    // Same store, so the delivered slot counts against the new handler's cap.
    capped.promos.load();
    market(GOOD);
    calls = [];
    await promote(capped.onPromote);

    expect(invoices()).toHaveLength(0);
  });
});

/**
 * The gate the whole product rests on. A paid card that reached the scoreboard would make
 * every other number on it unverifiable — and there is no way to un-publish a claim.
 */
describe('keeping it out of the record', () => {
  it('tracks a promoted coin under its own source, never as a call', async () => {
    market(GOOD);
    const h = handlers();
    await promote(h.onPromote);
    await h.onPaid(paid(String(invoices()[0]!.params.payload)));

    const tracked = h.tracker.list();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]).toMatchObject({ sourceId: PROMO_SOURCE_ID, outcome: 'promo' });
  });

  it('counts for nothing on the scoreboard, in either direction', async () => {
    market(GOOD);
    const h = handlers();
    await promote(h.onPromote);
    await h.onPaid(paid(String(invoices()[0]!.params.payload)));

    // Neither its wins nor its losses are ours: it is absent, not zeroed.
    expect(scoreboard(h.tracker.list()).called).toBe(0);
  });
});

describe('the promo card', () => {
  const call: ParsedCall = {
    token: {
      address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
      kind: 'solana',
      chain: 'solana',
      origin: 'labelled',
      confidence: 1,
    },
    pairAddress: 'PooL',
    name: 'Zhao',
    ticker: 'ZHAO',
    stats: { marketCapUsd: 400_000, liquidityUsd: 90_000 },
    candidates: [],
  };

  it('says it is not tracked, because it is not', () => {
    const html = renderPromo(call, config());
    expect(html).toContain('not tracking it in the record');
  });

  it('still carries a chart link, so the claim it makes can be checked', () => {
    expect(renderPromo(call, config())).toContain('dexscreener.com');
  });
});
