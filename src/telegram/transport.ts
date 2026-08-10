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
}

export interface SendResult {
  messageId?: number;
  dispatchAt: number;
  ackAt: number;
}

export interface SendOptions {
  /** Which latency bucket to record against. */
  stage?: string;
  silent?: boolean;
}

export interface PhotoOptions extends SendOptions {
  timeoutMs?: number;
}

export interface Transport {
  readonly kind: 'mtproto' | 'bot';
  /** Turns an `@name` or a `-100…` id from config into something sendable. */
  resolve(target: string): Promise<Peer>;
  send(peer: Peer, html: string, opts?: SendOptions): Promise<SendResult>;
  edit(peer: Peer, messageId: number, html: string): Promise<void>;
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
