import type { CompetitionConfig } from '../config';
import { renderLeaderboard, renderStanding } from '../format/leaderboard';
import { log } from '../log';
import { parseVerb } from '../parse/verb';
import type { BotApi } from '../telegram/botapi';
import type { DirectMessage } from '../telegram/botingest';
import type { MemberHandlers } from './member';
import type { PromoHandlers } from './promo';

export interface DirectDeps {
  api: BotApi;
  promo?: PromoHandlers;
  member?: MemberHandlers;
  competition: CompetitionConfig;
  /** For the help text, so a stranger who finds the bot is told where the calls actually are. */
  channelUrl?: string;
}

/**
 * Everything the bot does in a one-to-one chat.
 *
 * A separate handler from `createCommandHandler`, and that separation is load-bearing rather
 * than tidy: the command handler checks rights only for the public channel and trusts anything
 * else as the war room, so a `/signal` routed here from a stranger's DM would publish. Nothing
 * in this file can reach the channel. What it can do is sell a slot and take a competition
 * entry — both of which are gated on their own config, and neither of which posts a call.
 *
 * Every branch answers. A bot that reads a message and says nothing is indistinguishable from
 * a bot that has died, and the person typing has no way to tell which.
 */
export function createDirectHandler(deps: DirectDeps): (dm: DirectMessage) => Promise<void> {
  const { api, promo, member, competition, channelUrl } = deps;

  const reply = async (chatId: string, text: string) => {
    await api
      .call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // A leaderboard is full of nothing but coin tickers; letting Telegram unfurl one of
        // them would put an unvetted preview card under our own table.
        link_preview_options: { is_disabled: true },
      })
      .catch((err: Error) => log.debug(`could not reply in a DM: ${err.message}`));
  };

  const help = (): string => {
    const lines = [
      '👋 <b>pumpgod</b>',
      '',
      'Calls go out in the channel and every one of them is re-priced for 24 hours — ' +
        'losses included, which is the part you can check.',
      '',
    ];

    if (competition.enabled) {
      lines.push(
        '🏆 <b>Call competition</b>',
        `<code>/submit &lt;contract address&gt;</code> — enter a pick of your own. ` +
          `${competition.picksPerDay === 1 ? 'One a day' : `${competition.picksPerDay} a day`}, ` +
          'priced for 24 hours, scored on the peak.',
        '<code>/leaderboard</code> · <code>/me</code>',
        '',
        '<i>Your picks are never posted in the channel. Only the numbers reach the table.</i>',
        '',
      );
    }

    if (promo?.config.enabled) {
      lines.push(
        '📣 <b>Promotion</b>',
        `<code>/promote &lt;contract address&gt;</code> — ${promo.config.priceStars} ⭐, ` +
          `up to ${promo.config.dailyLimit} a day. Posted clearly marked as an advert, ` +
          'and kept out of the track record.',
        '',
      );
    }

    if (channelUrl) lines.push(`The channel: ${channelUrl}`);
    // Nothing on offer and nothing to point at would leave a blank message, which reads worse
    // than saying so.
    if (lines[lines.length - 1] === '') lines.push('<i>Nothing else is open right now.</i>');
    return lines.join('\n');
  };

  return async (dm: DirectMessage): Promise<void> => {
    const verb = parseVerb(dm.text);

    // Not a command at all. Someone who types "hey" gets told what this thing is, which is the
    // entire reason for having the DM surface open.
    if (!verb) return reply(dm.chatId, help());

    switch (verb.name) {
      case 'promote':
      case 'promo':
      case 'ad':
        if (!promo) return reply(dm.chatId, 'Promotion slots are not open at the moment.');
        if (!verb.rest) {
          return reply(dm.chatId, 'Send <code>/promote &lt;contract address&gt;</code> — the coin you want posted.');
        }
        return promo.onPromote(dm, verb.rest);

      case 'submit':
      case 'pick':
      case 'enter':
        if (!member) return reply(dm.chatId, 'The call competition is not running at the moment.');
        return reply(dm.chatId, await member.submit(dm, verb.rest));

      case 'leaderboard':
      case 'board':
      case 'top':
        if (!member) return reply(dm.chatId, 'The call competition is not running at the moment.');
        return reply(dm.chatId, renderLeaderboard(member.leaderboard(), competition));

      case 'me':
      case 'mine':
      case 'stats': {
        if (!member) return reply(dm.chatId, 'The call competition is not running at the moment.');
        const board = member.leaderboard();
        const at = board.findIndex((s) => s.memberId === dm.fromId);
        return reply(dm.chatId, renderStanding(board[at], competition, at >= 0 ? at + 1 : undefined));
      }

      default:
        // `/start`, `/help`, and every typo. All of them want the same thing: to be told what
        // is on offer, rather than to be corrected.
        return reply(dm.chatId, help());
    }
  };
}
