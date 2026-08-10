import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { CompetitionConfig } from '../src/config';
import { createCallbackHandler, pressData, DATA_LIMIT } from '../src/pipeline/callback';
import { createDirectHandler } from '../src/pipeline/direct';
import type { MemberHandlers, Standing } from '../src/pipeline/member';
import type { PromoHandlers } from '../src/pipeline/promo';
import { parseVerb } from '../src/parse/verb';
import { BotApi } from '../src/telegram/botapi';
import type { CallbackPress, DirectMessage } from '../src/telegram/botingest';

/**
 * The DM surface, which is the only place a stranger can type at us.
 *
 * `createCommandHandler` checks rights only for the public channel and trusts everything else
 * as the war room, so the thing worth proving here is negative: nothing typed into a DM can
 * reach it. The rest is that every branch answers — a bot that reads a message and says
 * nothing is indistinguishable from one that has died.
 */

let sent: Array<Record<string, unknown>>;
/** The Bot API method behind each entry in `sent`, read off the URL it went to. */
let calledMethods: string[];

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
  calledMethods = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? '{}') as Record<string, unknown>);
      calledMethods.push(String(url).split('/').pop() ?? '');
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

/**
 * The commonest thing anybody will send this bot, because the button on the pinned leaderboard
 * drops them into an empty DM and pasting the address is the obvious next move.
 */
describe('a pasted address', () => {
  const COIN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

  function buttons(): Array<{ text: string; data?: string }> {
    const markup = sent[0]!.reply_markup as { inline_keyboard?: Array<Array<{ text: string; data?: string }>> };
    return (markup?.inline_keyboard ?? []).flat();
  }

  /**
   * Not guessed at. A pick costs a member their one entry for the day and a promotion costs
   * real money, so an address that could mean either is asked about — and neither the tracker
   * nor an invoice is touched until the answer comes back.
   */
  it('is never acted on without being asked about', async () => {
    const h = handler();
    await h.handle(dm(COIN));

    expect(h.submitted).toHaveLength(0);
    expect(h.promoted).toHaveLength(0);
    expect(replies()[0]).toContain('Nothing happens until you choose');
  });

  it('comes back with the address already loaded, so answering is one tap', async () => {
    const h = handler();
    await h.handle(dm(COIN));

    expect(buttons().map((b) => b.data)).toEqual([`submit:${COIN}`, `promote:${COIN}`]);
  });

  it('offers only what is switched on', async () => {
    const h = handler({ promo: undefined });
    await h.handle(dm(COIN));

    expect(buttons().map((b) => b.data)).toEqual([`submit:${COIN}`]);
  });

  it('falls back to the help text when there is nothing to offer', async () => {
    const h = handler({ promo: undefined, member: undefined, competition: { enabled: false } });
    await h.handle(dm(COIN));

    expect(buttons()).toHaveLength(0);
    expect(replies()[0]).toContain('pumpgod');
  });

  // Telegram caps callback_data at 64 bytes and a Solana address is 44 of them, so the fit is
  // real but not generous — a button drawn with an over-long payload is silently rejected by
  // Telegram for the whole message, taking the working buttons with it.
  it('fits inside what a button can carry', () => {
    expect(Buffer.byteLength(`promote:${COIN}`)).toBeLessThanOrEqual(DATA_LIMIT);
    expect(pressData('submit', 'x'.repeat(64))).toBeUndefined();
  });
});

describe('pressing a button', () => {
  const COIN = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';

  function presser(over: { promo?: PromoHandlers; member?: MemberHandlers } = {}) {
    const base = stubs();
    const handle = createCallbackHandler({
      api: new BotApi('123:SECRET'),
      promo: 'promo' in over ? over.promo : base.promo,
      member: 'member' in over ? over.member : base.member,
    });
    return { ...base, handle };
  }

  function press(data: string, over: Partial<CallbackPress> = {}): CallbackPress {
    return { id: 'q1', chatId: '77', messageId: 5, fromId: '77', handle: '@alice', data, recvAt: 0, ...over };
  }

  /** Every method the bot called, in order — the answer has to be in there first. */
  const methods = (): string[] => calledMethods;

  /**
   * The one deadline in the file. An unanswered press spins on the presser's phone until
   * Telegram gives up on it, which reads as a bot that is broken rather than one that is busy —
   * so it is answered before the work, not after it.
   */
  it('stops the spinner before doing the work', async () => {
    const h = presser();
    await h.handle(press(`submit:${COIN}`));

    expect(methods()[0]).toBe('answerCallbackQuery');
    expect(h.submitted).toEqual([COIN]);
  });

  it('hands the address over exactly as the button carried it', async () => {
    const h = presser();
    await h.handle(press(`promote:${COIN}`));

    expect(h.promoted.map((p) => p.argument)).toEqual([COIN]);
  });

  /**
   * A press is not authenticated by anything except the button existing, and the data can be
   * replayed. It may only ever do what the presser could already have done by typing, which is
   * why there is no route from here to `/signal` any more than there is from a DM.
   */
  it('has no route to anything a DM could not reach', async () => {
    const h = presser();
    for (const data of ['signal:' + COIN, 'call:' + COIN, 'publish', '']) {
      await h.handle(press(data));
    }

    expect(h.submitted).toHaveLength(0);
    expect(h.promoted).toHaveLength(0);
    expect(methods().every((m) => m === 'answerCallbackQuery')).toBe(true);
  });

  it('says so rather than going quiet when the surface is off', async () => {
    const h = presser({ member: undefined });
    await h.handle(press(`submit:${COIN}`));

    expect(h.submitted).toHaveLength(0);
    expect(String(sent[0]!.text)).toContain('not running');
  });

  // Telegram drops the message off a press once it is old enough, so there is nowhere to put a
  // reply — and every answer here is a message, because a toast cannot hold a market cap.
  it('refuses a press it has nowhere to answer', async () => {
    const h = presser();
    await h.handle(press(`submit:${COIN}`, { chatId: undefined }));

    expect(h.submitted).toHaveLength(0);
    expect(String(sent[0]!.text)).toContain('too old');
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
