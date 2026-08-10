import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CompetitionConfig } from '../src/config';
import { createDirectHandler } from '../src/pipeline/direct';
import type { MemberHandlers, Standing } from '../src/pipeline/member';
import type { PromoHandlers } from '../src/pipeline/promo';
import { parseVerb } from '../src/parse/verb';
import { BotApi } from '../src/telegram/botapi';
import type { DirectMessage } from '../src/telegram/botingest';

/**
 * The DM surface, which is the only place a stranger can type at us.
 *
 * `createCommandHandler` checks rights only for the public channel and trusts everything else
 * as the war room, so the thing worth proving here is negative: nothing typed into a DM can
 * reach it. The rest is that every branch answers — a bot that reads a message and says
 * nothing is indistinguishable from one that has died.
 */

let sent: Array<Record<string, unknown>>;

const COMP: CompetitionConfig = { enabled: true, picksPerDay: 1, minSample: 5, size: 10 };

function dm(text: string, over: Partial<DirectMessage> = {}): DirectMessage {
  return { text, chatId: '77', messageId: 1, fromId: '77', handle: '@alice', recvAt: 0, ...over };
}

function stubs() {
  const promoted: Array<{ dm: DirectMessage; argument: string }> = [];
  const submitted: string[] = [];

  const promo = {
    onPromote: async (message: DirectMessage, argument: string) => void promoted.push({ dm: message, argument }),
    onPreCheckout: async () => undefined,
    onPaid: async () => undefined,
    config: { enabled: true, priceStars: 1150, dailyLimit: 3 },
  } satisfies PromoHandlers;

  const standing: Standing = {
    id: 'member:77',
    memberId: '77',
    handle: '@alice',
    picks: 6,
    priced: 6,
    unpriced: 0,
    medianPeak: 2.5,
    hit2x: 4,
    hit5x: 1,
    hit10x: 0,
    rugged: 0,
    medianEntryMcUsd: 100_000,
  };

  const member = {
    submit: async (_message: DirectMessage, argument?: string) => {
      submitted.push(argument ?? '');
      return 'entered';
    },
    leaderboard: () => [standing],
    standingFor: () => standing,
    members: undefined as never,
  } satisfies MemberHandlers;

  return { promo, member, promoted, submitted };
}

function handler(over: { promo?: PromoHandlers; member?: MemberHandlers; competition?: Partial<CompetitionConfig> } = {}) {
  const base = stubs();
  const handle = createDirectHandler({
    api: new BotApi('123:SECRET'),
    promo: 'promo' in over ? over.promo : base.promo,
    member: 'member' in over ? over.member : base.member,
    competition: { ...COMP, ...over.competition },
    channelUrl: 'https://t.me/pumpgod_fun',
  });
  return { ...base, handle };
}

/** The text of whatever the bot said back — the only thing the person on the other end sees. */
function replies(): string[] {
  return sent.map((s) => String(s.text));
}

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      return { json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response;
    }),
  );
});

afterEach(() => void vi.unstubAllGlobals());

describe('what a DM can and cannot reach', () => {
  /**
   * The whole reason this file exists. `/signal` published from a DM would let anybody on
   * Telegram post a call in our channel, and it is one forgotten branch away at all times.
   */
  it('has no route to /signal, whatever is typed', async () => {
    const h = handler();
    for (const text of ['/signal 9xQe', '/call 9xQe', 'signal 9xQe', '/SIGNAL@pumpgodbot 9xQe']) {
      await h.handle(dm(text));
    }

    expect(h.promoted).toHaveLength(0);
    expect(h.submitted).toHaveLength(0);
    // Every one of them still got an answer rather than silence.
    expect(replies()).toHaveLength(4);
    for (const reply of replies()) expect(reply).toContain('pumpgod');
  });

  it('answers anything that is not a command with what is on offer', async () => {
    const h = handler();
    await h.handle(dm('hey'));

    expect(replies()[0]).toContain('pumpgod');
    expect(replies()[0]).toContain('/submit');
  });

  it('treats /start and /help as the same question', async () => {
    const h = handler();
    await h.handle(dm('/start'));
    await h.handle(dm('/help'));

    expect(replies()[0]).toBe(replies()[1]);
  });

  it('never offers a surface that is switched off', async () => {
    const h = handler({ promo: undefined, competition: { enabled: false } });
    await h.handle(dm('/start'));

    expect(replies()[0]).not.toContain('/promote');
    expect(replies()[0]).not.toContain('/submit');
  });
});

describe('dispatch', () => {
  it('takes the spellings somebody would actually type for a promotion', async () => {
    const h = handler();
    for (const text of ['/promote abc', '/promo abc', '/ad abc', '/promote@pumpgodbot abc']) {
      await h.handle(dm(text));
    }

    expect(h.promoted.map((p) => p.argument)).toEqual(['abc', 'abc', 'abc', 'abc']);
  });

  it('hands the submit argument over without the verb attached', async () => {
    const h = handler();
    await h.handle(dm('/submit 9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'));

    expect(h.submitted).toEqual(['9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin']);
    expect(replies()[0]).toBe('entered');
  });

  it('asks for the address rather than opening an empty invoice', async () => {
    const h = handler();
    await h.handle(dm('/promote'));

    expect(h.promoted).toHaveLength(0);
    expect(replies()[0]).toContain('contract address');
  });

  it('renders the leaderboard, and a member their own record', async () => {
    const h = handler();
    await h.handle(dm('/leaderboard'));
    await h.handle(dm('/me'));

    expect(replies()[0]).toContain('call competition');
    expect(replies()[1]).toContain('your record');
    expect(replies()[1]).toContain('#1');
  });

  it('says the competition is shut rather than failing silently', async () => {
    const h = handler({ member: undefined });
    await h.handle(dm('/submit 9xQe'));
    await h.handle(dm('/leaderboard'));

    expect(replies()).toHaveLength(2);
    for (const reply of replies()) expect(reply).toContain('not running');
  });

  // A leaderboard is a list of tickers. Letting Telegram unfurl one would put an unvetted
  // preview card under our own table.
  it('never lets a link in a reply unfurl', async () => {
    const h = handler();
    await h.handle(dm('/start'));

    expect(sent[0]!.link_preview_options).toEqual({ is_disabled: true });
  });
});

describe('parseVerb', () => {
  it('lowercases the verb and strips the bot suffix', () => {
    expect(parseVerb('/Submit@pumpgodbot abc')).toEqual({ name: 'submit', rest: 'abc' });
  });

  it('reports a bare command, which is a request for help rather than nothing', () => {
    expect(parseVerb('/promote')).toEqual({ name: 'promote', rest: '' });
  });

  it('requires the slash, so a pasted address is never taken as a command', () => {
    expect(parseVerb('submit 9xQe')).toBeUndefined();
    expect(parseVerb('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')).toBeUndefined();
  });

  it('keeps the rest of the message intact', () => {
    expect(parseVerb('/submit  9xQe  please ')?.rest).toBe('9xQe  please');
  });
});
