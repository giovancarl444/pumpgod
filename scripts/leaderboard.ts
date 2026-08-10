import { loadCompetition, loadConfig } from '../src/config';
import { createMemberHandlers } from '../src/pipeline/member';
import { competitionBoard, readPinned, writePinned, BOARD_STORE } from '../src/social/pinned';
import { BotApi, chatIdFor } from '../src/telegram/botapi';
import { Tracker } from '../src/track/tracker';

/**
 * Posts the competition table once and pins it. From then on the daemon only ever edits it.
 *
 * Separate from the daemon for the same reason as the track record: pinning notifies the
 * channel and reorders what everyone sees at the top of it, and nothing that runs on a timer
 * should be able to do that.
 *
 * Unlike the track record this can be pinned while empty, and probably should be — an empty
 * table saying how to enter is the announcement.
 */

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const config = loadConfig();
  const competition = loadCompetition();

  if (!config.botToken) fail('Pinning goes through the Bot API. Set TG_BOT_TOKEN, or run `npm run setup`.');
  if (!config.channel) fail('PUMPGOD_CHANNEL is empty — there is nowhere to pin this.');
  if (!competition.enabled) {
    fail('COMP_ENABLED is false, so nobody can submit a pick. Turn it on before pinning a table for it.');
  }

  const existing = readPinned(BOARD_STORE);
  if (existing) {
    fail(
      `Already pinned: message ${existing.messageId} in ${existing.chatId}, and the daemon keeps it current.\n` +
        `  To start over, unpin it in Telegram and delete ${BOARD_STORE}.`,
    );
  }

  const tracker = new Tracker();
  const member = createMemberHandlers({ config, competition, tracker });
  member.members.load();

  const api = new BotApi(config.botToken);

  // Before the preview, not after. The board names the bot people are meant to message, so a
  // preview rendered without it would not be a preview of what gets pinned — and the daemon,
  // which does know the name, would rewrite the message on its very first pass.
  const me = await api.call<{ username?: string }>('getMe');
  const kind = competitionBoard(member, competition, me.username);
  const text = kind.render(Tracker.read());
  if (!text) fail('Nothing to render.');

  console.log(`\n${text}\n`);
  if (!process.argv.includes('--pin')) {
    console.log('  That is the preview. Re-run with --pin to post and pin it.\n');
    return;
  }

  const chatId = chatIdFor(config.channel);

  const sent = await api.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    message_thread_id: config.channelTopic,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: true,
    reply_markup: kind.keyboard ? { inline_keyboard: kind.keyboard } : undefined,
  });

  await api.call('pinChatMessage', {
    chat_id: chatId,
    message_id: sent.message_id,
    disable_notification: true,
  });

  const chat = await api.call<{ id: number }>('getChat', { chat_id: chatId });
  writePinned({ chatId: String(chat.id), messageId: sent.message_id, lastText: text }, BOARD_STORE);

  console.log(`  Pinned as message ${sent.message_id}. It updates itself from now on.`);
  // Telegram shows the most recently pinned message at the top of the chat. If the track
  // record is also pinned it has just been pushed below this one, which is worth knowing
  // before wondering where it went.
  console.log('  Telegram shows the newest pin first, so this now sits above the track record.\n');
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
