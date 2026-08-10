import { Api, TelegramClient } from 'telegram';
import { peerIdOf, resolveInputPeer } from './client';
import { deleteMessage } from './admin';
import { sendPhoto } from './photo';
import { editFast, sendFast } from './send';
import type { Peer, PhotoOptions, SendOptions, SendResult, Transport } from './transport';

/** Carries the resolved `InputPeer` so the hot path never pays for an entity lookup. */
export interface MtprotoPeer extends Peer {
  readonly input: Api.TypeInputPeer;
}

export function mtprotoPeer(input: Api.TypeInputPeer): MtprotoPeer {
  return { id: peerIdOf(input) ?? '', input };
}

/** What pumpgod has always done: a user account, over MTProto. */
export class MtprotoTransport implements Transport {
  readonly kind = 'mtproto' as const;

  constructor(private readonly client: TelegramClient) {}

  async resolve(target: string): Promise<MtprotoPeer> {
    return mtprotoPeer(await resolveInputPeer(this.client, target));
  }

  send(peer: Peer, html: string, opts: SendOptions = {}): Promise<SendResult> {
    return sendFast(this.client, (peer as MtprotoPeer).input, html, {
      stage: opts.stage ?? 'send',
      silent: opts.silent,
      replyTo: opts.replyTo,
    });
  }

  edit(peer: Peer, messageId: number, html: string): Promise<void> {
    return editFast(this.client, (peer as MtprotoPeer).input, messageId, html);
  }

  sendPhoto(peer: Peer, imageUrl: string, html: string, opts: PhotoOptions = {}): Promise<SendResult> {
    return sendPhoto(this.client, (peer as MtprotoPeer).input, imageUrl, html, {
      stage: opts.stage ?? 'send',
      timeoutMs: opts.timeoutMs ?? 2000,
      silent: opts.silent,
    });
  }

  delete(peer: Peer, messageId: number): Promise<void> {
    return deleteMessage(this.client, (peer as MtprotoPeer).input, messageId);
  }
}
