import { randomUUID } from 'node:crypto';
import type { AppConfig, PromoConfig } from '../config';
import { escapeHtml } from '../format/call';
import { promoButtons, renderPromo } from '../format/promo';
import { log } from '../log';
import { journal } from '../store/journal';
import { Promos, type PromoOrder } from '../store/promos';
import type { Tracker } from '../track/tracker';
import type { BotApi } from '../telegram/botapi';
import type { DirectMessage, PaidOrder, PreCheckout } from '../telegram/botingest';
import { answerCheckout, refundStars, sendStarInvoice, STARS } from '../telegram/stars';
import type { Peer, Transport } from '../telegram/transport';
import type { ParsedCall, Signal } from '../types';
import { resolveManualCall } from './manual';
import { assess } from './risk';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Its own source id, so a promoted coin lands in a different record from the same coin if we
 * ever call it ourselves. The two would otherwise merge on the tracker's key and there would be
 * one entry that is somehow both an advert and a call.
 */
export const PROMO_SOURCE_ID = 'promo';

export interface PromoDeps {
  api: BotApi;
  transport: Transport;
  config: AppConfig;
  promo: PromoConfig;
  channelPeer?: Peer;
  tracker?: Tracker;
  promos?: Promos;
}

export interface PromoHandlers {
  /**
   * `/promote <address>` from a DM. Dispatch lives in `direct.ts` — this module knows how to
   * sell a slot, not which of the bot's several commands was typed.
   */
  onPromote(dm: DirectMessage, argument: string): Promise<void>;
  onPreCheckout(query: PreCheckout): Promise<void>;
  onPaid(order: PaidOrder): Promise<void>;
  /** So the DM router can describe the offer without keeping its own copy of the price. */
  readonly config: PromoConfig;
}

/**
 * Selling a slot in the channel, end to end: quote, screen, charge, post, refund.
 *
 * The ordering is the design. **Nothing is charged for until the coin has been resolved and
 * screened**, so a honeypot cannot buy its way in front of the channel and then be argued
 * with, and the refund path stays reserved for our own failures rather than being the normal
 * way a bad coin gets turned away. Everything slow happens before the invoice for the same
 * reason: once Telegram opens a checkout there are ten seconds to answer it.
 */
export function createPromoHandlers(deps: PromoDeps): PromoHandlers {
  const { api, transport, config, promo, channelPeer, tracker } = deps;
  const promos = deps.promos ?? new Promos();
  const { priceStars, dailyLimit } = promo;

  const reply = async (chatId: string, text: string) => {
    await api.call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch((err: Error) => {
      log.debug(`could not reply in a DM: ${err.message}`);
    });
  };

  const onPromote = async (dm: DirectMessage, argument: string): Promise<void> => {
    if (!promo.enabled) {
      await reply(dm.chatId, 'Promotion slots are not open at the moment.');
      return;
    }
    if (!config.live || !channelPeer) {
      // Refusing rather than taking money for a post that would go nowhere.
      await reply(dm.chatId, 'The channel is not accepting posts right now — nothing has been charged.');
      return;
    }

    if (promos.postedSince(Date.now(), DAY_MS) >= dailyLimit) {
      await reply(dm.chatId, `Today's ${dailyLimit} slots are gone. Try again tomorrow.`);
      return;
    }

    // Resolving and screening before the invoice, not after. A coin that cannot be traded is
    // refused for free, which is both the honest answer and the one that needs no refund.
    const outcome = await resolveManualCall(argument, Math.max(config.enrichTimeoutMs, 5000), config.chains);
    if (!outcome.ok) {
      await reply(dm.chatId, `✗ ${escapeHtml(outcome.reason)}`);
      return;
    }

    const risk = assess(outcome.call, outcome.call.stats.marketCapUsd, true);
    if (risk.level === 'danger') {
      const why = risk.flags.map((f) => f.detail).join('; ');
      log.warn(`promo refused for ${argument}: ${why}`);
      await reply(
        dm.chatId,
        `✗ We will not post that one: ${escapeHtml(why)}.\n\nNothing has been charged.`,
      );
      return;
    }

    const address = outcome.call.token.address;
    const open = promos.pendingFor(dm.fromId, address);
    if (open) {
      await reply(dm.chatId, 'You already have an unpaid invoice open for that coin — pay or dismiss it first.');
      return;
    }

    const order: PromoOrder = {
      id: randomUUID(),
      state: 'invoiced',
      buyerId: dm.fromId,
      buyerHandle: dm.handle,
      chain: outcome.call.token.chain,
      address,
      ticker: outcome.call.ticker,
      name: outcome.call.name,
      stars: priceStars,
      createdAt: Date.now(),
    };
    promos.add(order);

    const label = order.ticker ? `$${order.ticker}` : address.slice(0, 8);
    try {
      await sendStarInvoice(api, {
        chatId: dm.chatId,
        title: `Promote ${label}`,
        // What they are buying, in the words we will be held to. No claim about performance,
        // because the card will say in its own text that we did not pick the coin.
        description:
          `One post in the pumpgod channel, marked as a paid promotion. ` +
          `It is not a pumpgod call and is not counted in the track record.`,
        payload: order.id,
        stars: priceStars,
        label: `${label} promotion`,
      });
    } catch (err) {
      // `void`, not `refunded` — nothing was ever charged, and the record has to say so or the
      // next `/promote` for the same coin is refused as a duplicate of an invoice that failed.
      promos.update(order, { state: 'void', failure: `invoice failed: ${(err as Error).message}` });
      log.warn(`could not send a promo invoice: ${(err as Error).message}`);
      await reply(dm.chatId, '✗ Could not open the invoice. Nothing has been charged — try again.');
    }
  };

  const onPreCheckout = async (query: PreCheckout): Promise<void> => {
    const order = promos.find(query.payload);
    if (!order) return answerCheckout(api, query.id, false, 'That order has expired. Send /promote again.');
    if (order.state !== 'invoiced') {
      return answerCheckout(api, query.id, false, 'That order has already been paid.');
    }
    if (query.currency !== STARS || query.amount !== order.stars) {
      // Cannot happen from Telegram's own invoice, which is why it is worth refusing outright
      // rather than accepting a price we did not set.
      log.warn(`checkout for ${order.id} asked for ${query.amount} ${query.currency}, not ${order.stars} ${STARS}`);
      return answerCheckout(api, query.id, false, 'That price no longer matches. Send /promote again.');
    }
    // The last free slot could have gone while the invoice sat open, and it is far better to
    // refuse here than to take the money and then have nowhere to put the post.
    if (promos.postedSince(Date.now(), DAY_MS) >= dailyLimit) {
      return answerCheckout(api, query.id, false, `Today's ${dailyLimit} slots have gone. Try tomorrow.`);
    }

    await answerCheckout(api, query.id, true);
  };

  const onPaid = async (paid: PaidOrder): Promise<void> => {
    const order = promos.find(paid.payload);
    if (!order) {
      // Money with no order behind it. Give it straight back; there is nothing to deliver.
      log.error(`paid promo ${paid.payload} has no order — refunding ${paid.amount} ${paid.currency}`);
      await refundStars(api, paid.fromId, paid.chargeId);
      await reply(paid.chatId, 'Something went wrong on our side and your Stars have been refunded.');
      return;
    }

    // Written down before anything is attempted with it. If the process dies on the next line,
    // the order is on disk as paid-and-undelivered rather than as an invoice nobody ever paid.
    promos.update(order, { state: 'paid', paidAt: Date.now(), chargeId: paid.chargeId });
    journal.write('promo-paid', { id: order.id, buyer: paid.fromId, stars: paid.amount, address: order.address });

    if (!channelPeer) return void (await failed(order, paid, 'the channel is not configured'));

    // Priced again rather than reusing the numbers from the invoice: an invoice can sit open
    // for a long time, and posting a market cap from before that wait would be a false claim
    // on the one card where we have taken money to make claims.
    const outcome = await resolveManualCall(order.address, Math.max(config.enrichTimeoutMs, 5000), config.chains);
    if (!outcome.ok) return void (await failed(order, paid, outcome.reason));

    try {
      const html = renderPromo(outcome.call, config);
      const keyboard = promoButtons(outcome.call, config);
      const image = config.showImage ? outcome.call.imageUrl : undefined;
      const sent = image
        ? await transport.sendPhoto(channelPeer, image, html, { stage: 'send.promo', keyboard })
        : await transport.send(channelPeer, html, { stage: 'send.promo', keyboard });

      promos.update(order, { state: 'posted', postedAt: Date.now() });
      tracker?.track(promoSignal(order, outcome.call), 'promo');
      journal.write('promo-posted', { id: order.id, messageId: sent.messageId, address: order.address });
      log.info(`📣 posted a paid promotion for ${order.ticker ? `$${order.ticker}` : order.address}`);

      await reply(paid.chatId, '✅ Posted. Thank you — it is up in the channel now.');
    } catch (err) {
      await failed(order, paid, (err as Error).message);
    }
  };

  /**
   * Paid for, not delivered. The only branch where a refund is right, and it is unconditional:
   * arguing about whose fault it was costs more than the Stars do.
   */
  const failed = async (order: PromoOrder, paid: PaidOrder, why: string): Promise<void> => {
    log.error(`promo ${order.id} was paid but not posted (${why}) — refunding`);
    const refunded = await refundStars(api, paid.fromId, paid.chargeId);
    promos.update(order, {
      state: refunded ? 'refunded' : 'owed',
      refundedAt: refunded ? Date.now() : undefined,
      failure: why,
    });
    journal.write('promo-failed', { id: order.id, why, refunded });
    await reply(
      paid.chatId,
      refunded
        ? `✗ We could not post it (${escapeHtml(why)}). Your Stars have been refunded.`
        : `✗ We could not post it (${escapeHtml(why)}), and the automatic refund failed. We will sort it by hand.`,
    );
  };

  promos.load();
  return { onPromote, onPreCheckout, onPaid, config: promo };
}

/**
 * The tracker takes a `Signal`, so a paid slot has to look like one to be recorded at all.
 *
 * Recorded on purpose rather than left out: someone paid for this and may ask what it did, and
 * the answer should not be a shrug. The `promo` outcome and the separate source id are what
 * keep it out of everything the channel claims for itself.
 */
function promoSignal(order: PromoOrder, call: ParsedCall): Signal {
  return {
    id: `promo-${order.id}`,
    source: { id: PROMO_SOURCE_ID, label: 'Paid promotion', mode: 'shadow', enabled: true },
    chatId: order.buyerId,
    messageId: 0,
    rawText: '',
    call,
    confirmations: [],
    ageSec: 0,
    stale: false,
    risk: { level: 'clear', flags: [] },
    timings: { messageUnix: Math.floor(Date.now() / 1000), recvAt: performance.now(), wallClockMs: Date.now() },
  };
}
