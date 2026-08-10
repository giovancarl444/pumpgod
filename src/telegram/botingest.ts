import { log } from '../log';
import type { BotApi } from './botapi';
import type { ControlChats, IncomingCommand, IncomingReaction } from './ingest';
import type { Admins } from './transport';

/** Only the fields we read. The Bot API sends a great deal more. */
interface BotUpdate {
  update_id: number;
  message?: BotMessage;
  channel_post?: BotMessage;
  message_reaction?: {
    chat: { id: number };
    message_id: number;
    user?: { id: number };
    new_reaction?: Array<{ type: string; emoji?: string }>;
  };
}

interface BotMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number };
  text?: string;
  caption?: string;
}

export interface BotIngestHandlers {
  onCommand(cmd: IncomingCommand): void;
  onReaction(reaction: IncomingReaction): void;
}

/**
 * Whether whoever typed a command may publish through us.
 *
 * A bot has no dialog list and no participant table to read, so this is one round trip per
 * unfamiliar user, cached. `getChatMember` answers for channels and supergroups alike, which
 * the MTProto version needed two separate paths for.
 */
export class BotAdmins implements Admins {
  private readonly cache = new Map<string, boolean>();

  constructor(
    private readonly api: BotApi,
    private readonly channelId: string | undefined,
  ) {}

  async allows(cmd: IncomingCommand): Promise<boolean> {
    // A channel post is proof in itself: Telegram only lets admins post to a broadcast channel.
    if (cmd.post) return true;
    if (!cmd.fromId || !this.channelId) return false;

    const cached = this.cache.get(cmd.fromId);
    if (cached !== undefined) return cached;

    const allowed = await this.lookup(cmd.fromId);
    this.cache.set(cmd.fromId, allowed);
    return allowed;
  }

  private async lookup(userId: string): Promise<boolean> {
    try {
      const member = await this.api.call<{ status: string }>('getChatMember', {
        chat_id: this.channelId,
        user_id: Number(userId),
      });
      return member.status === 'creator' || member.status === 'administrator';
    } catch (err) {
      log.debug(`admin check failed for ${userId}: ${(err as Error).message}`);
      return false;
    }
  }
}

/**
 * Long-polls `getUpdates`, which is the only way a bot receives anything — there is no socket
 * and no `catchUp` gap to recover, because Telegram holds updates until they are confirmed.
 *
 * The backlog is deliberately thrown away at boot. A `/signal` typed while the bot was down is
 * for a coin that moved hours ago, and republishing it is worse than missing it: the card would
 * carry an entry price nobody could have got. Confirming the backlog unread is how that is said.
 */
export function startBotIngest(
  api: BotApi,
  control: ControlChats,
  handlers: BotIngestHandlers,
): { stop(): void } {
  const { warRoomId, channelId } = control;
  let offset = 0;
  let stopped = false;

  const handle = (update: BotUpdate) => {
    const recvAt = performance.now();
    const post = update.channel_post;
    const message = post ?? update.message;

    if (message) {
      const text = message.text ?? message.caption;
      const chatId = String(message.chat.id);
      if (!text) return;
      if (chatId !== warRoomId && chatId !== channelId) return;

      handlers.onCommand({
        text,
        chatId,
        messageId: message.message_id,
        fromId: message.from ? String(message.from.id) : undefined,
        post: Boolean(post),
        fromChannel: chatId === channelId,
        recvAt,
      });
      return;
    }

    const reaction = update.message_reaction;
    if (!reaction || !warRoomId) return;
    const chatId = String(reaction.chat.id);
    if (chatId !== warRoomId) return;

    for (const r of reaction.new_reaction ?? []) {
      if (r.type === 'emoji' && r.emoji) {
        handlers.onReaction({
          chatId,
          messageId: reaction.message_id,
          emoji: r.emoji,
          reactorId: reaction.user ? String(reaction.user.id) : undefined,
          recvAt,
        });
      }
    }
  };

  const loop = async () => {
    // `offset: -1` returns at most the most recent update and confirms everything before it.
    try {
      const last = await api.call<BotUpdate[]>('getUpdates', { offset: -1, timeout: 0 });
      if (last.length) offset = last[last.length - 1]!.update_id + 1;
    } catch (err) {
      log.warn(`could not clear the update backlog: ${(err as Error).message}`);
    }

    while (!stopped) {
      try {
        const updates = await api.call<BotUpdate[]>(
          'getUpdates',
          {
            offset,
            timeout: 30,
            // Reactions are not delivered at all unless they are asked for by name, which is
            // what the 🚀 approval in the war room rides on.
            allowed_updates: ['message', 'channel_post', 'message_reaction'],
          },
          40_000,
        );

        for (const update of updates) {
          offset = Math.max(offset, update.update_id + 1);
          handle(update);
        }
      } catch (err) {
        if (stopped) return;
        // A dropped long poll is normal. Pausing keeps a persistent failure — a revoked token,
        // no network — from becoming a busy loop against Telegram.
        log.warn(`getUpdates failed: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };

  void loop();
  return {
    stop() {
      stopped = true;
    },
  };
}
