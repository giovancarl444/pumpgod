import { record } from '../metrics/latency';
import { log } from '../log';
import { parseHtml } from './html';
import { CAPTION_LIMIT } from './photo';
import type { Button, EditOptions, Peer, PhotoOptions, SendOptions, SendResult, Transport } from './transport';

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
    /**
     * Telegram publish a self-hostable Bot API server, and pointing at one is the only way to
     * exercise this path — boot, ingest, publish — without a real token and a real channel.
     * Read at construction rather than at import, so `.env` has already been loaded.
     */
    private readonly base = process.env.TG_API_BASE?.trim() || BASE,
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
      const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
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

/** The part of `getChatMember` that decides whether we can publish. */
export interface ChatMember {
  status: string;
  can_post_messages?: boolean;
  can_delete_messages?: boolean;
}

export interface BotRights {
  ok: boolean;
  detail: string;
  /** One line, and it must say what to actually do in Telegram. */
  hint?: string;
  /** Whether a typed `/signal` can be tidied away after the card goes out. */
  canDelete: boolean;
}

/**
 * What the bot may do in a chat it has been added to.
 *
 * Worth asking before a call depends on the answer, because the failure is otherwise silent
 * and late: "administrator" on a broadcast channel is a title that can be handed out with
 * *no* permissions behind it, and Telegram only mentions the missing post right at the moment
 * the first real call fails to send.
 */
export function botRights(chatType: string, member: ChatMember): BotRights {
  const kind = chatType === 'channel' ? 'broadcast channel' : chatType === 'private' ? 'private chat' : 'group';
  const promote = 'add the bot as an admin there, with "Post Messages" ticked';

  if (member.status === 'left' || member.status === 'kicked') {
    return { ok: false, detail: `${kind} · the bot is not in it`, hint: promote, canDelete: false };
  }
  if (member.status === 'creator') return { ok: true, detail: `${kind} · creator`, canDelete: true };

  if (member.status !== 'administrator') {
    // A plain member can talk in a group, never in a broadcast channel.
    return chatType === 'channel'
      ? { ok: false, detail: `${kind} · not an admin, and only admins can post here`, hint: promote, canDelete: false }
      : { ok: true, detail: `${kind} · member, can post`, canDelete: false };
  }

  if (member.can_post_messages === false) {
    return {
      ok: false,
      detail: `${kind} · admin, but "Post Messages" is off`,
      hint: 'open the chat\'s admin list, edit the bot, and tick "Post Messages"',
      canDelete: false,
    };
  }

  return { ok: true, detail: `${kind} · admin, can post`, canDelete: member.can_delete_messages !== false };
}

/**
 * A button URL Telegram will accept. Anything else is `BUTTON_URL_INVALID`, which fails the
 * **whole** call — the card does not go out at all. A misconfigured `TRADE_URL_SOL` is a
 * plausible way to get here, and losing the button is a far smaller loss than losing the call,
 * so a bad one is dropped rather than sent. The same link is in the message body regardless.
 */
function usableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:' || protocol === 'tg:';
  } catch {
    return false;
  }
}

/**
 * Telegram wants `undefined` rather than an empty keyboard, and an empty `inline_keyboard`
 * array is rejected outright — so a caller passing no buttons must send no markup at all.
 */
function markup(keyboard: Button[][] | undefined): unknown {
  if (!keyboard?.length) return undefined;
  const rows = keyboard
    .map((row) => row.filter((b) => (b.url ? usableUrl(b.url) : Boolean(b.data))))
    .filter((row) => row.length);
  if (!rows.length) return undefined;
  return {
    inline_keyboard: rows.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
    ),
  };
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
      message_thread_id: peer.threadId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      disable_notification: opts.silent ?? false,
      reply_to_message_id: opts.replyTo,
      // Without this, answering a message somebody has since deleted is a hard error and the
      // milestone is lost outright. Landing unthreaded is the lesser failure by a distance.
      allow_sending_without_reply: true,
      reply_markup: markup(opts.keyboard),
    });
    const ackAt = performance.now();
    record(opts.stage ?? 'send', ackAt - dispatchAt);
    return { messageId: msg.message_id, dispatchAt, ackAt };
  }

  async edit(peer: Peer, messageId: number, html: string, opts: EditOptions = {}): Promise<void> {
    await this.api.call('editMessageText', {
      chat_id: peer.id,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: markup(opts.keyboard),
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
        message_thread_id: peer.threadId,
        photo: imageUrl,
        caption: html,
        parse_mode: 'HTML',
        disable_notification: opts.silent ?? false,
        reply_markup: markup(opts.keyboard),
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
