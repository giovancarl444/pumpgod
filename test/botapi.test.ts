import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotTransport, chatIdFor } from '../src/telegram/botapi';

/**
 * The bot is the half of pumpgod that can publish without a phone number, so it is the half
 * that will actually be running. Everything here is a failure that looks like success from the
 * outside: a card posted to the wrong chat, artwork that silently takes a call down with it,
 * or a rate limit answered by giving up on a call we already won the race for.
 */

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** Serves the Bot API. `replies` are consumed in order; anything after them is a plain ok. */
function api(replies: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({
        method: url.slice(url.lastIndexOf('/') + 1),
        params: JSON.parse(init.body) as Record<string, unknown>,
      });
      const body = replies.shift() ?? { ok: true, result: { message_id: 1 } };
      return { json: async () => body } as Response;
    }),
  );
  return { calls, transport: new BotTransport(new BotApi('123:SECRET')) };
}

const PEER = { id: '-1001234567890' };
const CARD = '<b>$WIF</b> — <a href="https://axiom.trade/t/abc">buy</a>\nmc <code>$41K</code>';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('naming the chat', () => {
  // `.env` may carry any of the three spellings depending on whether setup wrote it or it was
  // typed by hand, and config strips the -100 prefix for its own keys. Get this wrong and the
  // card goes nowhere, or to a chat that merely shares the digits.
  it('takes a username, a -100 id and a bare id to the same three forms', () => {
    expect(chatIdFor('@pumpgod')).toBe('@pumpgod');
    expect(chatIdFor('pumpgod')).toBe('@pumpgod');
    expect(chatIdFor('-1001234567890')).toBe('-1001234567890');
    expect(chatIdFor('1234567890')).toBe('-1001234567890');
  });
});

describe('sending a card', () => {
  it('passes our HTML through untranslated', async () => {
    // Every tag the renderers emit is one the Bot API's HTML mode already understands, so the
    // card is sent verbatim. Anything that rewrote it would be a second formatter to keep in
    // step with the MTProto one.
    const { calls, transport } = api();
    await transport.send(PEER, CARD);

    expect(calls[0]!.method).toBe('sendMessage');
    expect(calls[0]!.params).toMatchObject({
      chat_id: '-1001234567890',
      text: CARD,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('waits the time Telegram asks for and sends anyway', async () => {
    const { calls, transport } = api([
      { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } },
      { ok: true, result: { message_id: 7 } },
    ]);

    await expect(transport.send(PEER, CARD)).resolves.toMatchObject({ messageId: 7 });
    expect(calls).toHaveLength(2);
  });

  it('gives up on an error that waiting cannot fix', async () => {
    const { calls, transport } = api([{ ok: false, error_code: 400, description: 'chat not found' }]);

    await expect(transport.send(PEER, CARD)).rejects.toThrow('chat not found');
    expect(calls).toHaveLength(1);
  });

  // The token is the entire credential — whoever holds it owns the bot — and it sits in the
  // URL of every request. An error that quoted the URL would put it in the logs.
  it('never puts the token in the error', async () => {
    const { transport } = api([{ ok: false, error_code: 401, description: 'Unauthorized' }]);
    const err = (await transport.send(PEER, CARD).catch((e: Error) => e)) as Error;

    expect(err.message).toContain('Unauthorized');
    expect(err.message).not.toContain('SECRET');
    expect(err.stack ?? '').not.toContain('SECRET');
  });
});

describe('sending a card with artwork', () => {
  it('hands Telegram the URL rather than the bytes', async () => {
    const { calls, transport } = api();
    await transport.sendPhoto(PEER, 'https://cdn.example/coin.png', CARD);

    expect(calls[0]!.method).toBe('sendPhoto');
    expect(calls[0]!.params).toMatchObject({ photo: 'https://cdn.example/coin.png', caption: CARD });
  });

  it('still sends the call when the image is refused', async () => {
    // A call that goes out without artwork is a call. A call that does not go out because a
    // CDN was slow is a miss, and a miss is the only failure this project cannot recover from.
    const { calls, transport } = api([
      { ok: false, error_code: 400, description: 'wrong file identifier' },
      { ok: true, result: { message_id: 9 } },
    ]);

    await expect(transport.sendPhoto(PEER, 'https://cdn.example/coin.png', CARD)).resolves.toMatchObject({
      messageId: 9,
    });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
  });

  it('measures the caption limit on the rendered text, not the markup', async () => {
    // A caption is capped at 1024 characters as the reader sees them. Counting the HTML would
    // drop a card to plain text for tags nobody can see — worse, counting it the other way
    // would post a card Telegram rejects outright.
    const long = `<b>${'x'.repeat(1000)}</b>`;
    const { calls, transport } = api();
    await transport.sendPhoto(PEER, 'https://cdn.example/coin.png', long);

    expect(calls[0]!.method).toBe('sendPhoto');
  });

  it('drops to text when the caption really is too long', async () => {
    const { calls, transport } = api();
    await transport.sendPhoto(PEER, 'https://cdn.example/coin.png', 'x'.repeat(1100));

    expect(calls[0]!.method).toBe('sendMessage');
  });
});
