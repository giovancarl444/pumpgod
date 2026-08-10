import type { Agent } from '../agent/agent';
import type { CompetitionConfig } from '../config';
import { escapeHtml } from '../format/call';
import { renderLeaderboard, renderStanding } from '../format/leaderboard';
import { log } from '../log';
import { classifyAddress } from '../parse/addresses';
import { parseVerb } from '../parse/verb';
import type { BotApi } from '../telegram/botapi';
import type { DirectMessage } from '../telegram/botingest';
import type { Button } from '../telegram/transport';
import { pressData } from './callback';
import type { MemberHandlers } from './member';
import type { PromoHandlers } from './promo';

export interface DirectDeps {
  api: BotApi;
  promo?: PromoHandlers;
  member?: MemberHandlers;
  competition: CompetitionConfig;
  /** For the help text, so a stranger who finds the bot is told where the calls actually are. */
  channelUrl?: string;
  /**
   * Answers questions that are not commands — the record, the worst call, what we screen for.
   *
   * Strictly additive. It only ever runs on text that reached the help fallback anyway, and
   * anything it does not recognise still gets `help()`, so switching it off changes nothing
   * except how much of a real question goes unanswered.
   */
  agent?: Agent;
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
  const { api, promo, member, competition, channelUrl, agent } = deps;

  const reply = async (chatId: string, text: string, keyboard?: Button[][]) => {
    await api
      .call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        // A leaderboard is full of nothing but coin tickers; letting Telegram unfurl one of
        // them would put an unvetted preview card under our own table.
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard?.length ? { inline_keyboard: keyboard } : undefined,
      })
      .catch((err: Error) => log.debug(`could not reply in a DM: ${err.message}`));
  };

  /**
   * A contract address on its own, with no verb in front of it.
   *
   * The commonest thing anyone will ever send this bot, because the pinned leaderboard's button
   * drops them into an empty DM and pasting the address is the obvious next move. Answering it
   * with the general help text would be technically correct and would lose most of them.
   *
   * It is not guessed at. `/submit` costs a member their one pick for the day and `/promote`
   * costs real money, so an address that could mean either is asked about rather than acted on —
   * but asked about with the address already loaded into the buttons, so saying which costs one
   * tap and not another paste.
   */
  const offer = async (dm: DirectMessage, address: string): Promise<void> => {
    const buttons: Button[] = [];
    if (member) {
      const data = pressData('submit', address);
      if (data) buttons.push({ text: '🏆 Enter it in the competition', data });
    }
    if (promo?.config.enabled) {
      const data = pressData('promote', address);
      if (data) buttons.push({ text: `📣 Promote it · ${promo.config.priceStars} ⭐`, data });
    }

    if (!buttons.length) return reply(dm.chatId, help());

    return reply(
      dm.chatId,
      [
        `<code>${escapeHtml(short(address))}</code>`,
        '',
        buttons.length === 1
          ? 'Tap below to enter it. Nothing is entered until you do.'
          : 'What would you like to do with it? Nothing happens until you choose.',
      ].join('\n'),
      buttons.map((b) => [b]),
    );
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
        '<i>Your picks are never posted in the channel. Only the numbers reach the table — ' +
          'and I message you when one of them runs.</i>',
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

    if (competition.enabled || promo?.config.enabled) {
      lines.push('<i>Or just paste a contract address and pick from the buttons.</i>', '');
    }

    if (channelUrl) lines.push(`The channel: ${channelUrl}`);
    // Nothing on offer and nothing to point at would leave a blank message, which reads worse
    // than saying so.
    if (lines[lines.length - 1] === '') lines.push('<i>Nothing else is open right now.</i>');
    return lines.join('\n');
  };

  return async (dm: DirectMessage): Promise<void> => {
    const verb = parseVerb(dm.text);

    if (!verb) {
      // A bare contract address is an intention, not a greeting, and it is what the button on
      // the pinned leaderboard produces.
      const bare = dm.text.trim();
      if (classifyAddress(bare)) return offer(dm, bare);

      /**
       * Anything else is a question rather than a command, and most of them are the same six
       * questions. The agent answers the ones it has a real lookup for and hands back the rest.
       *
       * A greeting and an unrecognised question both fall through to `help()` on purpose: in a
       * one-to-one chat, somebody who has just found the bot needs orienting more than they
       * need an apology, and `help()` is the only thing here that knows which surfaces are
       * actually switched on.
       */
      const said = agent?.ask({
        text: bare,
        userId: dm.fromId,
        chatId: dm.chatId,
        surface: 'dm',
        addressed: true,
      });
      if (said && said.intent !== 'greeting' && said.intent !== 'unknown') {
        return reply(dm.chatId, said.text);
      }

      // Someone who types "hey" gets told what this thing is, which is the entire reason for
      // having the DM surface open.
      return reply(dm.chatId, help());
    }

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

/** Enough of an address to recognise, without a wall of base58 in the middle of a sentence. */
function short(address: string): string {
  return address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
