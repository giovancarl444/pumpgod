import { afterEach, describe, expect, it, vi } from 'vitest';
import { Api, TelegramClient, helpers } from 'telegram';
import { CAPTION_LIMIT, fetchImage, sendPhoto } from '../src/telegram/photo';

const PEER = new Api.InputPeerSelf();
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function response(body: Buffer, init: { status?: number; type?: string } = {}): Response {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': init.type ?? 'image/png' }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

/** Records what actually reached the wire, so a test can tell a photo from a text post. */
function harness(overrides: { uploadFails?: boolean; sendMediaFails?: boolean } = {}) {
  const calls: Array<{ kind: 'photo' | 'text'; message: string }> = [];

  const client = {
    uploadFile: async () => {
      if (overrides.uploadFails) throw new Error('FILE_PARTS_INVALID');
      return new Api.InputFile({ id: helpers.generateRandomLong(), parts: 1, name: 'x.png', md5Checksum: '' });
    },
    invoke: async (req: unknown) => {
      if (req instanceof Api.messages.SendMedia) {
        if (overrides.sendMediaFails) throw new Error('PHOTO_INVALID_DIMENSIONS');
        calls.push({ kind: 'photo', message: req.message ?? '' });
      }
      if (req instanceof Api.messages.SendMessage) calls.push({ kind: 'text', message: req.message ?? '' });
      return { updates: [new Api.UpdateMessageID({ id: 42, randomId: helpers.generateRandomLong() })] };
    },
  } as unknown as TelegramClient;

  return { client, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchImage', () => {
  it('returns the bytes for a real image', async () => {
    vi.stubGlobal('fetch', async () => response(PNG));
    const image = await fetchImage('https://cdn.example/coin.png', 500);

    expect(image?.bytes).toEqual(PNG);
    expect(image?.name).toBe('coin.png');
  });

  // DexScreener answers a missing profile with an HTML page, not a 404. Uploading that
  // would produce a post with a broken image rather than a post with none.
  it('refuses anything that is not an image, however cheerfully it was served', async () => {
    vi.stubGlobal('fetch', async () => response(Buffer.from('<!doctype html>'), { type: 'text/html' }));
    expect(await fetchImage('https://cdn.example/missing', 500)).toBeUndefined();
  });

  it('gives up on a non-200 rather than uploading an error body', async () => {
    vi.stubGlobal('fetch', async () => response(PNG, { status: 503 }));
    expect(await fetchImage('https://cdn.example/coin.png', 500)).toBeUndefined();
  });

  it('gives up rather than hanging when the CDN does not answer', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });
    expect(await fetchImage('https://cdn.example/slow.png', 30)).toBeUndefined();
  });

  it('names the file by what was served, not by what the URL claimed', async () => {
    vi.stubGlobal('fetch', async () => response(PNG, { type: 'image/jpeg' }));
    expect((await fetchImage('https://cdn.example/coin.png', 500))?.name).toBe('coin.jpg');
  });

  // Telegram takes a photo as JPEG or PNG. A GIF or WebP is a document to it, and the upload
  // is refused only after the bytes are on the wire — on a coin whose logo is an animation
  // that is megabytes spent to publish the call without the picture anyway.
  it('refuses formats Telegram will not take as a photo, before uploading them', async () => {
    for (const type of ['image/gif', 'image/webp']) {
      vi.stubGlobal('fetch', async () => response(PNG, { type }));
      expect(await fetchImage('https://cdn.example/coin.png', 500)).toBeUndefined();
    }
  });
});

describe('sendPhoto', () => {
  it('posts the card as a photo with the message as its caption', async () => {
    vi.stubGlobal('fetch', async () => response(PNG));
    const { client, calls } = harness();

    const sent = await sendPhoto(client, PEER, 'https://cdn.example/coin.png', '<b>WIF</b>', {
      stage: 'test',
      timeoutMs: 500,
    });

    expect(sent.hadImage).toBe(true);
    expect(sent.messageId).toBe(42);
    expect(calls).toEqual([{ kind: 'photo', message: 'WIF' }]);
  });

  // Every one of these is a case where the call still has to go out. A call posted without
  // artwork is a call; a call not posted because a CDN was slow is a miss.
  it('still posts the call when the image cannot be fetched', async () => {
    vi.stubGlobal('fetch', async () => response(Buffer.alloc(0), { status: 404 }));
    const { client, calls } = harness();

    const sent = await sendPhoto(client, PEER, 'https://cdn.example/gone.png', '<b>WIF</b>', {
      stage: 'test',
      timeoutMs: 500,
    });

    expect(sent.hadImage).toBe(false);
    expect(calls).toEqual([{ kind: 'text', message: 'WIF' }]);
  });

  it('still posts the call when Telegram refuses the upload', async () => {
    vi.stubGlobal('fetch', async () => response(PNG));
    const { client, calls } = harness({ uploadFails: true });

    const sent = await sendPhoto(client, PEER, 'https://cdn.example/coin.png', '<b>WIF</b>', {
      stage: 'test',
      timeoutMs: 500,
    });

    expect(sent.hadImage).toBe(false);
    expect(calls).toEqual([{ kind: 'text', message: 'WIF' }]);
  });

  it('still posts the call when Telegram rejects the photo itself', async () => {
    vi.stubGlobal('fetch', async () => response(PNG));
    const { client, calls } = harness({ sendMediaFails: true });

    const sent = await sendPhoto(client, PEER, 'https://cdn.example/coin.png', '<b>WIF</b>', {
      stage: 'test',
      timeoutMs: 500,
    });

    expect(sent.hadImage).toBe(false);
    expect(calls.map((c) => c.kind)).toEqual(['text']);
  });

  it('posts as text when the coin has no artwork, without reaching for the network', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { client, calls } = harness();

    const sent = await sendPhoto(client, PEER, undefined, '<b>WIF</b>', { stage: 'test', timeoutMs: 500 });

    expect(sent.hadImage).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: 'text', message: 'WIF' }]);
  });

  // Telegram truncates an over-long caption silently. Dropping the photo keeps the whole
  // call readable, which matters more than the picture.
  it('drops the photo rather than the words when the card is too long to caption', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { client, calls } = harness();

    const long = 'x'.repeat(CAPTION_LIMIT + 1);
    const sent = await sendPhoto(client, PEER, 'https://cdn.example/coin.png', long, {
      stage: 'test',
      timeoutMs: 500,
    });

    expect(sent.hadImage).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls[0]!.message).toHaveLength(CAPTION_LIMIT + 1);
  });
});
