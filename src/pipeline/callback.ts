import { log } from '../log';
import type { BotApi } from '../telegram/botapi';
import type { CallbackPress, DirectMessage } from '../telegram/botingest';
import type { MemberHandlers } from './member';
import type { PromoHandlers } from './promo';

/**
 * Telegram caps `callback_data` at 64 **bytes**. A Solana address is 44 characters, so a verb
 * and a separator have 20 to live in — comfortable, but not enough to start packing extras in
 * beside the address later.
 */
export const DATA_LIMIT = 64;

/**
 * A button's instruction, as it travels there and back.
 *
 * Built here rather than written by hand at each call site so that the string the button carries
 * and the string this file parses cannot drift apart — they are the same function, read in two
 * directions, and a typo in one of them is a button that silently does nothing.
 */
export function pressData(verb: string, argument: string): string | undefined {
  const data = `${verb}:${argument}`;
  if (Buffer.byteLength(data) > DATA_LIMIT) {
    log.warn(`callback data for ${verb} is too long to fit on a button, so no button was drawn`);
    return undefined;
  }
  return data;
}

export interface CallbackDeps {
  api: BotApi;
  promo?: PromoHandlers;
  member?: MemberHandlers;
}

/**
 * What happens when somebody taps a button.
 *
 * **Every press is answered, whatever else happens**, and that is the first thing done rather
 * than the last: an unanswered button spins on the presser's screen until Telegram gives up on
 * it, which reads as a bot that is broken rather than one that is busy. The work happens after
 * the spinner has been dismissed, and reports itself as an ordinary message.
 *
 * A press carries no authority. Anyone who can see a message can press its buttons and the data
 * can be replayed, so this may only ever do something the presser could have done by typing — in
 * practice that means the DM verbs, and it is why this handler has no route to the channel any
 * more than `direct.ts` does.
 */
export function createCallbackHandler(deps: CallbackDeps): (press: CallbackPress) => Promise<void> {
  const { api, promo, member } = deps;

  const answer = async (id: string, text?: string) => {
    await api
      .call('answerCallbackQuery', { callback_query_id: id, text })
      .catch((err: Error) => log.debug(`could not answer a button press: ${err.message}`));
  };

  const say = async (chatId: string, text: string) => {
    await api
      .call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } })
      .catch((err: Error) => log.debug(`could not reply to a button press: ${err.message}`));
  };

  return async (press: CallbackPress): Promise<void> => {
    const cut = press.data.indexOf(':');
    const verb = cut === -1 ? press.data : press.data.slice(0, cut);
    const argument = cut === -1 ? '' : press.data.slice(cut + 1);

    // Without a chat there is nowhere to put the answer, and every branch below answers with a
    // message rather than with the toast — a toast cannot hold a market cap.
    if (!press.chatId) return answer(press.id, 'That message is too old to act on. Send the command instead.');

    // Rebuilt rather than carried: a press is not a message, and the handlers below want the
    // one thing it has in common with one — who, and where to reply.
    const dm: DirectMessage = {
      text: '',
      chatId: press.chatId,
      messageId: press.messageId ?? 0,
      fromId: press.fromId,
      handle: press.handle,
      recvAt: press.recvAt,
    };

    switch (verb) {
      case 'submit': {
        if (!member) return answer(press.id, 'The competition is not running.');
        await answer(press.id, 'Checking that coin…');
        return say(press.chatId, await member.submit(dm, argument));
      }

      case 'promote': {
        if (!promo) return answer(press.id, 'Promotion slots are not open.');
        await answer(press.id, 'Opening the invoice…');
        return promo.onPromote(dm, argument);
      }

      default:
        // A button we no longer draw, pressed on a message old enough to still have it. Saying
        // so beats a spinner that stops for no visible reason.
        log.debug(`unknown button press: ${press.data.slice(0, 32)}`);
        return answer(press.id, 'That button no longer does anything.');
    }
  };
}
