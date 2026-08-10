import { Api, TelegramClient } from 'telegram';
import { Raw } from 'telegram/events';
import type { Source } from '../types';

export interface IncomingMessage {
  source: Source;
  chatId: string;
  messageId: number;
  text: string;
  entities?: Api.TypeMessageEntity[];
  messageUnix: number;
  recvAt: number;
  isEdit: boolean;
}

export interface IncomingReaction {
  chatId: string;
  messageId: number;
  emoji: string;
  reactorId?: string;
  recvAt: number;
}

/** Something typed in the war room. Commands are how we call a coin of our own. */
export interface IncomingCommand {
  text: string;
  messageId: number;
  recvAt: number;
}

export interface IngestHandlers {
  /** Must stay synchronous. Anything slow belongs behind a promise the handler kicks off. */
  onMessage(msg: IncomingMessage): void;
  onReaction(reaction: IncomingReaction): void;
  onCommand(cmd: IncomingCommand): void;
}

function peerKey(peer: Api.TypePeer): string | undefined {
  if (peer instanceof Api.PeerChannel) return peer.channelId.toString();
  if (peer instanceof Api.PeerChat) return peer.chatId.toString();
  if (peer instanceof Api.PeerUser) return peer.userId.toString();
  return undefined;
}

/**
 * Subscribes to raw updates rather than GramJS's NewMessage event. The high-level event
 * builder resolves senders and chats before it hands anything over, which can mean a
 * network round trip — on this path that would cost more than everything else combined.
 *
 * Returns the handler it registered, so `npm run drill` can push a message through the
 * exact same code path instead of a copy of it that could drift.
 */
export function attachIngest(
  client: TelegramClient,
  watched: Map<string, Source>,
  warRoomId: string | undefined,
  handlers: IngestHandlers,
): (update: Api.TypeUpdate) => void {
  const onUpdate = (update: Api.TypeUpdate) => {
    const recvAt = performance.now();

    const isNew = update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage;
    const isEdit =
      update instanceof Api.UpdateEditChannelMessage || update instanceof Api.UpdateEditMessage;

    if (isNew || isEdit) {
      const message = (update as { message: Api.TypeMessage }).message;
      if (!(message instanceof Api.Message)) return;

      const text = message.message;
      if (!text) return;

      const chatId = peerKey(message.peerId);
      if (!chatId) return;

      // The war room is where we talk to ourselves. Telegram delivers our own outgoing
      // messages to every other session of the account, so typing a command on a phone
      // reaches the running bot.
      if (chatId === warRoomId && isNew) {
        handlers.onCommand({ text, messageId: message.id, recvAt });
        return;
      }

      const source = watched.get(chatId);
      if (!source || !source.enabled) return;

      handlers.onMessage({
        source,
        chatId,
        messageId: message.id,
        text,
        entities: message.entities,
        messageUnix: message.date,
        recvAt,
        isEdit,
      });
      return;
    }

    // Approval happens by reacting in the war room. A user account cannot receive inline
    // button callbacks — those are delivered to bots only — and a reaction is one tap.
    if (update instanceof Api.UpdateMessageReactions) {
      if (!warRoomId) return;
      const chatId = peerKey(update.peer);
      if (chatId !== warRoomId) return;

      for (const r of update.reactions.recentReactions ?? []) {
        if (r.reaction instanceof Api.ReactionEmoji) {
          handlers.onReaction({
            chatId,
            messageId: update.msgId,
            emoji: r.reaction.emoticon,
            reactorId: peerKey(r.peerId),
            recvAt,
          });
        }
      }
    }
  };

  client.addEventHandler(onUpdate, new Raw({}));
  return onUpdate;
}
