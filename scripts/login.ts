import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config as loadEnv } from 'dotenv';

loadEnv();

/**
 * Produces the TG_SESSION string. Run once, paste the result into .env, and never share
 * it — it is a full credential for the account, not a scoped token.
 */
async function main() {
  const apiId = Number(process.env.TG_API_ID);
  const apiHash = process.env.TG_API_HASH;

  if (!apiId || !apiHash) {
    console.error('Set TG_API_ID and TG_API_HASH in .env first (get them at https://my.telegram.org).');
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => rl.question('Phone number (with country code, e.g. +447700900000): '),
    password: () => rl.question('Two-factor password (blank if none): '),
    phoneCode: () => rl.question('Code Telegram just sent you: '),
    onError: (err) => console.error(err.message),
  });

  const me = await client.getMe();
  console.log(`\n✅ Logged in as @${(me as { username?: string }).username ?? 'unknown'}\n`);
  console.log('Add this line to .env:\n');
  console.log(`TG_SESSION=${client.session.save()}\n`);
  console.log('Treat it like a password. Anyone holding it controls this account.\n');

  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
