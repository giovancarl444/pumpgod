import { log } from '../log';
import type { BotApi } from './botapi';

/**
 * Telegram Stars — the only way a bot may sell a digital good.
 *
 * This is a platform rule, not a preference: card processors are for physical goods and real
 * services, and anything delivered inside Telegram has to be paid for in Stars or not at all.
 * That is why there is no provider token anywhere here, and why the currency is hardcoded.
 *
 * Stars are also why the price lives in config rather than in a constant. Telegram sets the
 * exchange rate, the app stores take a cut of the purchase, and the payout rate moves — so a
 * figure that means €20 today is a figure that means something else in six months, and only
 * whoever is running the channel can look up what it should be.
 */
export const STARS = 'XTR';

export interface InvoiceRequest {
  chatId: string;
  title: string;
  description: string;
  /** Comes back verbatim on both the checkout query and the receipt. 128 bytes, and ours. */
  payload: string;
  stars: number;
  /** What the pay button says. Telegram writes the amount into it itself. */
  label?: string;
}

/**
 * Sends the invoice. The Pay button is Telegram's own — generated from this call, not a
 * keyboard we attach — which is why selling something needs no callback handling at all.
 */
export async function sendStarInvoice(api: BotApi, req: InvoiceRequest): Promise<number | undefined> {
  const msg = await api.call<{ message_id: number }>('sendInvoice', {
    chat_id: req.chatId,
    title: req.title,
    description: req.description,
    payload: req.payload,
    currency: STARS,
    // A Stars invoice carries exactly one price line, and its `amount` is a whole number of
    // Stars rather than the hundredths every other currency here would be counted in.
    prices: [{ label: req.label ?? req.title, amount: req.stars }],
  });
  return msg.message_id;
}

/**
 * Yes or no to a charge Telegram is holding open, **within 10 seconds of being asked**.
 *
 * Past the deadline the buyer is shown a failure with no reason attached, so a refusal that
 * arrives late reads exactly like the bot being broken. Everything worth checking — that the
 * coin resolves, that it passes the screen, that there is a slot left today — is therefore
 * checked before the invoice goes out, and this is left as a formality.
 *
 * `reason` is shown to the buyer, so it has to say what to do next.
 */
export async function answerCheckout(
  api: BotApi,
  queryId: string,
  ok: boolean,
  reason?: string,
): Promise<void> {
  try {
    await api.call('answerPreCheckoutQuery', {
      pre_checkout_query_id: queryId,
      ok,
      error_message: ok ? undefined : (reason ?? 'That order is no longer valid. Start again.'),
    });
  } catch (err) {
    // Nothing to do about it. Saying so matters because the money silently does not move.
    log.warn(`could not answer the checkout in time: ${(err as Error).message}`);
  }
}

/**
 * Gives the Stars back.
 *
 * The escape hatch for the one failure that cannot be shrugged off: payment succeeded and
 * delivery did not. Refunding on our own initiative costs a fraction of what an unanswered
 * complaint costs a channel that sells anything, so this is called rather than logged.
 */
export async function refundStars(api: BotApi, userId: string, chargeId: string): Promise<boolean> {
  try {
    await api.call('refundStarPayment', {
      user_id: Number(userId),
      telegram_payment_charge_id: chargeId,
    });
    log.info(`refunded ${chargeId} to ${userId}`);
    return true;
  } catch (err) {
    log.error(`REFUND FAILED for ${userId} (${chargeId}) — refund it by hand`, (err as Error).message);
    return false;
  }
}
