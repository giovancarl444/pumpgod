import { Api, TelegramClient } from 'telegram';
import { log } from '../log';
import type { IncomingCommand } from './ingest';

/**
 * Whether whoever typed a command in the public channel is allowed to publish through us.
 *
 * A broadcast channel answers this for free: Telegram only lets admins post there, so the
 * message existing is the proof. A supergroup does not — every member can type — so the
 * membership has to be read back, which costs a round trip. Cached because the answer
 * changes about once a year and a command should not pay for it twice.
 *
 * The war room is deliberately not routed through here. It is a private chat you chose,
 * everyone in it is trusted, and requiring admin rights there would break the flow of
 * handing the room to a friend.
 */
export class AdminCheck {
  private readonly cache = new Map<string, boolean>();

  constructor(
    private readonly client: TelegramClient,
    private readonly channelPeer: Api.TypeInputPeer | undefined,
  ) {}

  async allows(cmd: IncomingCommand): Promise<boolean> {
    if (cmd.post) return true;

    // No identifiable sender and not a channel post: we cannot say who this was, so we do
    // not act on it. The war room path never reaches here.
    if (!cmd.fromId) return false;

    const cached = this.cache.get(cmd.fromId);
    if (cached !== undefined) return cached;

    const allowed = await this.lookup(cmd.fromId);
    this.cache.set(cmd.fromId, allowed);
    return allowed;
  }

  private async lookup(userId: string): Promise<boolean> {
    if (!(this.channelPeer instanceof Api.InputPeerChannel)) return false;

    try {
      const result = await this.client.invoke(
        new Api.channels.GetParticipant({
          channel: new Api.InputChannel({
            channelId: this.channelPeer.channelId,
            accessHash: this.channelPeer.accessHash,
          }),
          participant: await this.client.getInputEntity(Number(userId)),
        }),
      );
      const p = result.participant;
      return p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChannelParticipantAdmin;
    } catch (err) {
      // USER_NOT_PARTICIPANT and a failed entity resolve both land here, and both mean the
      // same thing for our purposes.
      log.debug(`admin check failed for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }
}

/** Removes the typed command, so the channel shows the card and not the instruction. */
export async function deleteMessage(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  messageId: number,
): Promise<void> {
  if (peer instanceof Api.InputPeerChannel) {
    await client.invoke(
      new Api.channels.DeleteMessages({
        channel: new Api.InputChannel({ channelId: peer.channelId, accessHash: peer.accessHash }),
        id: [messageId],
      }),
    );
    return;
  }
  await client.invoke(new Api.messages.DeleteMessages({ id: [messageId], revoke: true }));
}
