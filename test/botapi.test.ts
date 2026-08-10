import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotApi, BotTransport, botRights, chatIdFor } from '../src/telegram/botapi';

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

describe('naming the server', () => {
  // Telegram publish a self-hostable Bot API server, and pointing at one is also the only way
  // to exercise boot → ingest → publish without a real token and a real channel.
  it('talks to a self-hosted server when given one, and to Telegram otherwise', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        seen.push(url);
        return { json: async () => ({ ok: true, result: {} }) } as Response;
      }),
    );

    await new BotApi('123:SECRET', 10_000, 'http://127.0.0.1:8081').call('getMe');
    await new BotApi('123:SECRET').call('getMe');

    expect(seen[0]).toBe('http://127.0.0.1:8081/bot123:SECRET/getMe');
    expect(seen[1]).toBe('https://api.telegram.org/bot123:SECRET/getMe');
  });
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

/**
 * What the bot may do where. Every verdict here is one the doctor prints as a ✓ or a ✗ before
 * a call depends on it, so a wrong branch is worse than no check: it certifies a channel that
 * will swallow every call.
 */
describe('reading our own rights in a chat', () => {
  it('passes a channel admin who can post, and the creator', () => {
    expect(botRights('channel', { status: 'administrator', can_post_messages: true }).ok).toBe(true);
    expect(botRights('channel', { status: 'creator' }).ok).toBe(true);
  });

  // The one that is invisible until the first real call fails. "Administrator" on a broadcast
  // channel is a title Telegram will hand out with no permissions behind it at all.
  it('fails an admin whose post right was never ticked', () => {
    const rights = botRights('channel', { status: 'administrator', can_post_messages: false });
    expect(rights.ok).toBe(false);
    expect(rights.hint).toContain('Post Messages');
  });

  it('fails a channel it is merely a member of, where only admins can post', () => {
    expect(botRights('channel', { status: 'member' }).ok).toBe(false);
  });

  it('lets it post in a group as an ordinary member, which is the rule there', () => {
    expect(botRights('supergroup', { status: 'member' }).ok).toBe(true);
  });

  it('says it is not in a chat it was removed from, rather than that it lacks a right', () => {
    for (const status of ['left', 'kicked']) {
      const rights = botRights('channel', { status });
      expect(rights.ok).toBe(false);
      expect(rights.detail).toContain('not in it');
    }
  });

  // Delete rights are not a blocker — the call still goes out. They decide whether the typed
  // /signal is left sitting above the card it produced.
  it('separates being able to publish from being able to tidy up after', () => {
    expect(botRights('channel', { status: 'administrator', can_delete_messages: false })).toMatchObject({
      ok: true,
      canDelete: false,
    });
    expect(botRights('channel', { status: 'administrator', can_delete_messages: true }).canDelete).toBe(true);
  });
});

/**
 * A group with Topics turned on has one chat id and many threads, and Telegram treats a send
 * with no thread as General rather than refusing it. So the failure mode for a missing
 * `message_thread_id` is a card posted where members are talking, which reads as the setting
 * being ignored rather than as an error anybody can act on.
 */
describe('posting into a forum topic', () => {
  const IN_TOPIC = { id: '-1001234567890', threadId: 291 };

  it('carries the thread on a card sent as a photo', async () => {
    const { calls, transport } = api();
    await transport.sendPhoto(IN_TOPIC, 'https://img.example/coin.png', CARD);

    expect(calls[0]!.method).toBe('sendPhoto');
    expect(calls[0]!.params.message_thread_id).toBe(291);
  });

  it('carries the thread on a plain text send', async () => {
    const { calls, transport } = api();
    await transport.send(IN_TOPIC, CARD);

    expect(calls[0]!.params.message_thread_id).toBe(291);
  });

  // The artwork fallback is the path a call actually takes when Telegram cannot fetch the
  // image, so losing the thread here would put exactly the calls that went wrong in General.
  it('keeps the thread when the photo fails and it falls back to text', async () => {
    const { calls, transport } = api([{ ok: false, error_code: 400, description: 'wrong file identifier' }]);
    await transport.sendPhoto(IN_TOPIC, 'https://img.example/broken.png', CARD);

    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(calls[1]!.params.message_thread_id).toBe(291);
  });

  it('leaves the thread out entirely for a chat that has no topics', async () => {
    const { calls, transport } = api();
    await transport.send(PEER, CARD);

    expect(calls[0]!.params.message_thread_id).toBeUndefined();
  });
});
