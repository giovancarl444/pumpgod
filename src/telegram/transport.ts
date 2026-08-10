import type { IncomingCommand } from './ingest';

/**
 * How a call reaches Telegram, without the pipeline knowing which kind of account sent it.
 *
 * Two exist and they are not interchangeable at the account level: a bot can publish to a
 * channel it administers but can never read a group it was not added to, and a user account can
 * read any group it has joined but carries a phone number and a ban risk. The end state runs
 * both — a bot that owns the channel, and an expendable reader account for rival groups — so
 * that losing the reader does not take the channel with it. That is only possible if nothing
 * above this file knows the difference.
 */
export interface Peer {
  /** Stable identity, for comparing against an incoming chat id and for journalling. */
  readonly id: string;
  /**
   * Which forum topic to post into. A supergroup with Topics turned on still has one chat id;
   * the topic is a thread inside it, and a send that omits this lands in General rather than
   * failing — which is why a misconfigured topic looks like the bot ignoring the setting.
   */
  readonly threadId?: number;
}

export interface SendResult {
  messageId?: number;
  dispatchAt: number;
  ackAt: number;
}

/**
 * One tappable button. `url` opens something, `data` comes back to us as a callback.
 *
 * Telegram caps `callback_data` at 64 **bytes**, which a 44-character Solana address plus a
 * verb only just fits inside — anything carrying an address has no room to spare.
 */
export interface Button {
  text: string;
  url?: string;
  data?: string;
}

export interface SendOptions {
  /** Which latency bucket to record against. */
  stage?: string;
  silent?: boolean;
  /**
   * Hang this message under an earlier one. Used to report a milestone beneath the call that
   * made it, so the claim and its entry price are read together.
   *
   * Best effort by design: the message being answered may have been deleted or aged out, and
   * losing the thread is a better outcome than losing the message.
   */
  replyTo?: number;
  /**
   * Rows of buttons under the message.
   *
   * **Dropped by the MTProto transport, silently and unavoidably** — reply markup is a bot
   * capability, and a user account cannot attach it. So a button may never be the only way to
   * reach something: whatever it offers has to exist in the message body too, or the same card
   * sent from the reader account loses it with no error raised anywhere.
   */
  keyboard?: Button[][];
}

export interface PhotoOptions extends SendOptions {
  timeoutMs?: number;
}

export interface EditOptions {
  /**
   * The buttons to leave under the message.
   *
   * **Omitting this removes them.** Telegram reads an edit carrying no markup as an edit *to*
   * no markup, so the enrichment pass that rewrites a card a few seconds after it lands would
   * quietly strip its own Buy button unless it passes the keyboard again.
   */
  keyboard?: Button[][];
}

export interface Transport {
  readonly kind: 'mtproto' | 'bot';
  /** Turns an `@name` or a `-100…` id from config into something sendable. */
  resolve(target: string): Promise<Peer>;
  send(peer: Peer, html: string, opts?: SendOptions): Promise<SendResult>;
  edit(peer: Peer, messageId: number, html: string, opts?: EditOptions): Promise<void>;
  /**
   * Falls back to a plain send when the image cannot be fetched in time. A call is worth more
   * on time without artwork than late with it.
   */
  sendPhoto(peer: Peer, imageUrl: string, html: string, opts?: PhotoOptions): Promise<SendResult>;
  /** Removes the typed command so the channel shows the card and not the instruction. */
  delete(peer: Peer, messageId: number): Promise<void>;
}

/** Whether whoever typed a command in the public channel may publish through us. */
export interface Admins {
  allows(cmd: IncomingCommand): Promise<boolean>;
}
