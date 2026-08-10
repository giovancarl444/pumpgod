import { record } from '../metrics/latency';
import { log } from '../log';
import { parseHtml } from './html';
import { CAPTION_LIMIT } from './photo';
import type { Peer, PhotoOptions, SendOptions, SendResult, Transport } from './transport';

const BASE = 'https://api.telegram.org';

export interface BotChat {
  id: string;
  type: string;
  title?: string;
  username?: string;
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export class BotApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    description: string,
  ) {
    super(description);
    this.name = 'BotApiError';
  }
}

/**
 * The HTTP Bot API. One method, because every call has the same shape: POST JSON, get an
 * envelope back, unwrap it or throw.
 *
 * The token is the whole credential — anyone holding it owns the bot — so it appears in the
 * URL and must never reach a log line. Errors carry the method and description, never the URL.
 */
export class BotApi {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    // 429 is the one failure worth retrying: Telegram states exactly how long to wait, and a
    // call arriving a second late still beats one that never arrives.
    for (let attempt = 0; ; attempt++) {
      const body = await this.post<T>(method, params, timeoutMs ?? this.timeoutMs);
      const wait = body.parameters?.retry_after;
      if (body.ok) return body.result as T;
      if (wait === undefined || attempt >= 1) {
        throw new BotApiError(method, body.error_code, body.description ?? 'no description');
      }
      log.warn(`telegram asked us to wait ${wait}s on ${method}`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  private async post<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Envelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      return (await res.json()) as Envelope<T>;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * `chat_id` as the Bot API wants it: an `@username`, or the full `-100…` form for a channel.
 * `.env` may carry any of the three depending on whether it was picked by setup or typed by
 * hand, and `config.normalisePeerId` strips the prefix for source keys — so it has to go back.
 */
export function chatIdFor(target: string): string {
  const t = target.trim();
  if (t.startsWith('@')) return t;
  if (!/^-?\d+$/.test(t)) return `@${t}`;
  return Number(t) > 0 ? `-100${t}` : t;
}

/** A bot: publishes anywhere it is an admin, reads nothing it was not added to. */
export class BotTransport implements Transport {
  readonly kind = 'bot' as const;

  constructor(private readonly api: BotApi) {}

  async resolve(target: string): Promise<Peer> {
    // Asked once at boot so a bot that was never added to the channel says so now, by name,
    // rather than at the moment the first call needs to go out.
    const chat = await this.api.call<BotChat>('getChat', { chat_id: chatIdFor(target) });
    return { id: String(chat.id) };
  }

  async send(peer: Peer, html: string, opts: SendOptions = {}): Promise<SendResult> {
    const dispatchAt = performance.now();
    const msg = await this.api.call<{ message_id: number }>('sendMessage', {
      chat_id: peer.id,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: opts.silent ?? false,
    });
    const ackAt = performance.now();
    record(opts.stage ?? 'send', ackAt - dispatchAt);
    return { messageId: msg.message_id, dispatchAt, ackAt };
  }

  async edit(peer: Peer, messageId: number, html: string): Promise<void> {
    await this.api.call('editMessageText', {
      chat_id: peer.id,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  }

  /**
   * Telegram fetches the image itself from the URL, so unlike the MTProto path there is no
   * download and no upload in front of the call — the artwork costs nothing but the bytes of
   * the link. When it cannot fetch it, the call still goes out as text.
   */
  async sendPhoto(peer: Peer, imageUrl: string, html: string, opts: PhotoOptions = {}): Promise<SendResult> {
    if (parseHtml(html).text.length > CAPTION_LIMIT) return this.send(peer, html, opts);

    const dispatchAt = performance.now();
    try {
      const msg = await this.api.call<{ message_id: number }>('sendPhoto', {
        chat_id: peer.id,
        photo: imageUrl,
        caption: html,
        parse_mode: 'HTML',
        disable_notification: opts.silent ?? false,
      });
      const ackAt = performance.now();
      record(`${opts.stage ?? 'send'}.photo`, ackAt - dispatchAt);
      return { messageId: msg.message_id, dispatchAt, ackAt };
    } catch (err) {
      log.warn(`photo send failed, posting without it: ${(err as Error).message}`);
      return this.send(peer, html, opts);
    }
  }

  async delete(peer: Peer, messageId: number): Promise<void> {
    await this.api.call('deleteMessage', { chat_id: peer.id, message_id: messageId });
  }
}
