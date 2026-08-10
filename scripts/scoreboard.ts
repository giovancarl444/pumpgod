import { loadConfig } from '../src/config';
import { renderScoreboard } from '../src/format/scoreboard';
import { readPinned, writePinned, STORE } from '../src/social/pinned';
import { BotApi, chatIdFor } from '../src/telegram/botapi';
import { scoreboard } from '../src/track/stats';
import { Tracker } from '../src/track/tracker';

/**
 * Posts the track record once and pins it. From then on the daemon only ever edits it.
 *
 * Separate from the daemon on purpose. Pinning is a loud, one-time act — it notifies the
 * channel and replaces whatever was pinned before — and nothing that runs on a timer should
 * be able to do it. Run by hand, once, when there is a record worth pinning.
 */

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main() {
  const config = loadConfig();

  // Bot API only: `pinChatMessage` has no equivalent on the transport, and the bot is the
  // account that owns the channel.
  if (!config.botToken) fail('Pinning goes through the Bot API. Set TG_BOT_TOKEN, or run `npm run setup`.');
  if (!config.channel) fail('PUMPGOD_CHANNEL is empty — there is nowhere to pin this.');

  const existing = readPinned();
  if (existing) {
    fail(
      `Already pinned: message ${existing.messageId} in ${existing.chatId}, and the daemon keeps it current.\n` +
        `  To start over, unpin it in Telegram and delete ${STORE}.`,
    );
  }

  const text = renderScoreboard(scoreboard(Tracker.read()));
  if (!text) fail('No published calls yet. There is nothing to claim, so nothing to pin.');

  console.log(`\n${text}\n`);
  if (!process.argv.includes('--pin')) {
    console.log('  That is the preview. Re-run with --pin to post and pin it.\n');
    return;
  }

  const api = new BotApi(config.botToken);
  const chatId = chatIdFor(config.channel);

  const sent = await api.call<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    message_thread_id: config.channelTopic,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    disable_notification: true,
  });

  await api.call('pinChatMessage', {
    chat_id: chatId,
    message_id: sent.message_id,
    disable_notification: true,
  });

  // The chat id is stored as the bot reports it, not as it was typed, because that is what
  // the running daemon will compare its own resolved peer against.
  const chat = await api.call<{ id: number }>('getChat', { chat_id: chatId });
  writePinned({ chatId: String(chat.id), messageId: sent.message_id, lastText: text });

  console.log(`  Pinned as message ${sent.message_id}. It updates itself from now on.\n`);
}

main().catch((err) => {
  console.error(`\n  ${(err as Error).message}\n`);
  process.exit(1);
});
