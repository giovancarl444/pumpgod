import { Api, TelegramClient, helpers } from 'telegram';
import { CustomFile } from 'telegram/client/uploads';
import { record } from '../metrics/latency';
import { parseHtml } from './html';
import { log } from '../log';
import { extractMessageId, sendFast, type SendResult } from './send';

/** Telegram rejects a caption over 1024 UTF-16 code units. Ours runs ~300. */
export const CAPTION_LIMIT = 1024;

/** Well past any coin logo; a URL that serves something enormous is not one we want. */
const MAX_BYTES = 5 * 1024 * 1024;

export interface FetchedImage {
  bytes: Buffer;
  /** Extension Telegram will infer the format from. */
  name: string;
}

/**
 * Downloads the artwork ourselves rather than handing Telegram the URL via
 * `InputMediaPhotoExternal`. That form is one round trip fewer, but it fails opaquely — the
 * server fetches the URL out of band and reports a generic error, so a CDN that rate-limits
 * us looks identical to a coin with no image. Doing it here means we can tell the two apart,
 * and the caller can decide to post anyway.
 */
export async function fetchImage(url: string, timeoutMs: number): Promise<FetchedImage | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return undefined;

    const type = res.headers.get('content-type') ?? '';
    // Anything else is a placeholder page or an error body, and uploading it would produce
    // a broken post rather than a failed one.
    if (!/^image\/(png|jpeg|jpg|webp|gif)/i.test(type)) {
      log.debug(`image at ${url} was ${type || 'untyped'}, not an image`);
      return undefined;
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) return undefined;

    return { bytes, name: `coin.${extensionFor(type)}` };
  } catch (err) {
    if ((err as Error).name !== 'AbortError') log.debug('image fetch failed', (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function extensionFor(contentType: string): string {
  if (/webp/i.test(contentType)) return 'webp';
  if (/png/i.test(contentType)) return 'png';
  if (/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

/**
 * Posts the card as a photo with the message as its caption.
 *
 * Falls back to a plain text message whenever the image cannot be had — a call that goes out
 * without artwork is a call; a call that does not go out because a CDN was slow is a miss,
 * and misses are the only failure this project cannot recover from.
 */
export async function sendPhoto(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  imageUrl: string | undefined,
  html: string,
  opts: { stage: string; timeoutMs: number; silent?: boolean },
): Promise<SendResult & { hadImage: boolean }> {
  const { text, entities } = parseHtml(html);

  const image = imageUrl && text.length <= CAPTION_LIMIT ? await fetchImage(imageUrl, opts.timeoutMs) : undefined;
  if (!image) {
    const sent = await sendFast(client, peer, html, { stage: opts.stage, silent: opts.silent });
    return { ...sent, hadImage: false };
  }

  try {
    const file = await client.uploadFile({
      file: new CustomFile(image.name, image.bytes.length, '', image.bytes),
      workers: 1,
    });

    const dispatchAt = performance.now();
    const result = await client.invoke(
      new Api.messages.SendMedia({
        peer,
        media: new Api.InputMediaUploadedPhoto({ file }),
        message: text,
        entities,
        randomId: helpers.generateRandomLong(),
        silent: opts.silent ?? false,
      }),
    );
    const ackAt = performance.now();
    record(`${opts.stage}.photo`, ackAt - dispatchAt);

    return { messageId: extractMessageId(result), dispatchAt, ackAt, hadImage: true };
  } catch (err) {
    // Telegram refuses some images the CDN was happy to serve — PHOTO_INVALID_DIMENSIONS on
    // an extreme aspect ratio is the usual one. The call still goes out.
    log.warn(`photo upload failed, posting without it: ${(err as Error).message}`);
    const sent = await sendFast(client, peer, html, { stage: opts.stage, silent: opts.silent });
    return { ...sent, hadImage: false };
  }
}
