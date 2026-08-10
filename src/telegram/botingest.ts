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
  pre_checkout_query?: {
    id: string;
    from: BotUser;
    invoice_payload: string;
    total_amount: number;
    currency: string;
  };
}

interface BotUser {
  id: number;
  username?: string;
  first_name?: string;
}

interface BotMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: BotUser;
  text?: string;
  caption?: string;
  /** Present only in a group with Topics on, and only outside General. */
  message_thread_id?: number;
  /** Telegram's receipt. Arrives as an ordinary message with no text on it at all. */
  successful_payment?: {
    currency: string;
    total_amount: number;
    invoice_payload: string;
    telegram_payment_charge_id: string;
  };
}

/**
 * Somebody talking to the bot one-to-one.
 *
 * Kept apart from `IncomingCommand` deliberately, because it is the opposite kind of thing: a
 * command comes from a chat we control and is trusted on that basis, while this is from anyone
 * on Telegram who found the bot. Merging the two would put `/signal` from a stranger's DM on
 * the same footing as one typed in the war room.
 */
export interface DirectMessage {
  text: string;
  chatId: string;
  messageId: number;
  fromId: string;
  /** For addressing somebody by name, and for naming who paid on a refund. */
  handle?: string;
  recvAt: number;
}

/**
 * Telegram's last word before it moves the money, and the only chance to refuse.
 *
 * **Must be answered inside 10 seconds.** Miss it and the charge fails with an error the buyer
 * cannot act on — so anything slow belongs before the invoice, not here.
 */
export interface PreCheckout {
  id: string;
  fromId: string;
  payload: string;
  /** In whatever `currency` says. For Stars that is a whole number of them. */
  amount: number;
  currency: string;
}

/** The money has arrived. From here it is deliver or refund; there is no third option. */
export interface PaidOrder {
  chatId: string;
  fromId: string;
  handle?: string;
  payload: string;
  amount: number;
  currency: string;
  /** What `refundStarPayment` needs, and the only proof the charge ever happened. */
  chargeId: string;
  recvAt: number;
}

export interface BotIngestHandlers {
  onCommand(cmd: IncomingCommand): void;
  onReaction(reaction: IncomingReaction): void;
  /**
   * A one-to-one message from anybody. Leaving this off is how DMs stay invisible, which is
   * the state the bot shipped in and the right default: a chat nobody is watching is a support
   * queue that silently accumulates.
   */
  onDirect?(dm: DirectMessage): void;
  onPreCheckout?(query: PreCheckout): void;
  onPaid?(order: PaidOrder): void;
}

function handleOf(user: BotUser | undefined): string | undefined {
  if (!user) return undefined;
  return user.username ? `@${user.username}` : user.first_name;
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
/**
 * How long Telegram is asked to hold an idle connection open.
 *
 * Deliberately under 30. Node's `fetch` abandons a response whose headers have not arrived
 * within 30s — undici's `headersTimeout`, which is not reachable through the fetch API — and
 * Telegram sends nothing at all until it has an update or the poll expires. Asking for exactly
 * 30 made the two deadlines a dead heat that fetch won, so every quiet half-minute produced
 * `getUpdates failed: fetch failed` and a 3s deaf gap, on a loop, forever.
 */
const POLL_SECONDS = 25;

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

    // Answered before anything else, because the 10-second deadline on it is the only one in
    // this file, and everything below is a queue it would be waiting behind.
    const checkout = update.pre_checkout_query;
    if (checkout) {
      handlers.onPreCheckout?.({
        id: checkout.id,
        fromId: String(checkout.from.id),
        payload: checkout.invoice_payload,
        amount: checkout.total_amount,
        currency: checkout.currency,
      });
      return;
    }

    const post = update.channel_post;
    const message = post ?? update.message;

    if (message) {
      const chatId = String(message.chat.id);
      const isControl = chatId === warRoomId || chatId === channelId;

      // A receipt carries no text at all, so it has to be read before the text check below
      // drops it — and losing this update means money taken for something never delivered.
      const paid = message.successful_payment;
      if (paid && message.from) {
        handlers.onPaid?.({
          chatId,
          fromId: String(message.from.id),
          handle: handleOf(message.from),
          payload: paid.invoice_payload,
          amount: paid.total_amount,
          currency: paid.currency,
          chargeId: paid.telegram_payment_charge_id,
          recvAt,
        });
        return;
      }

      const text = message.text ?? message.caption;
      if (!text) return;

      /**
       * Anything that is not a control chat is at most a DM, and DMs go somewhere else
       * entirely. `createCommandHandler` checks rights only for the public channel and trusts
       * everything else as the war room — so routing a stranger's DM into `onCommand` would
       * let anybody on Telegram publish a call by messaging the bot privately.
       *
       * The control check comes first so that a war room configured as a one-to-one chat with
       * the bot — which is a perfectly reasonable way to set it up — keeps working.
       */
      if (!isControl) {
        if (message.chat.type === 'private' && message.from) {
          handlers.onDirect?.({
            text,
            chatId,
            messageId: message.message_id,
            fromId: String(message.from.id),
            handle: handleOf(message.from),
            recvAt,
          });
        }
        return;
      }

      // The only way to read a topic's id off Telegram at all. There is no method that lists
      // them, and the id is not the number in a copied message link, so without this the
      // setting can only be arrived at by guessing and watching where the card lands.
      log.info(
        `command from chat ${chatId} · ${
          message.message_thread_id ? `topic ${message.message_thread_id}` : 'General (no topic)'
        }`,
      );

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
            timeout: POLL_SECONDS,
            // Named one by one because Telegram's default list quietly leaves out both the
            // reaction the war room's 🚀 approval rides on and the pre-checkout query, which
            // has to be answered for a payment to complete at all. A receipt for a completed
            // payment arrives as an ordinary `message`, so it needs no entry of its own.
            allowed_updates: ['message', 'channel_post', 'message_reaction', 'pre_checkout_query'],
          },
          (POLL_SECONDS + 5) * 1000,
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
