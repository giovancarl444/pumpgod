import { createInterface, type Interface } from 'node:readline/promises';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config as loadEnv } from 'dotenv';

/**
 * Everything between a fresh clone and a working `/signal`, in one command.
 *
 * The pieces already existed as separate scripts, and separately they are four rounds of
 * run-something, read-a-value, edit-a-file, run-the-next-thing — with the session string
 * copied by hand in the middle of it. That is the part of this project most likely to be got
 * wrong, and it is the part that has nothing to do with calling coins.
 *
 * Nothing here is destructive: a value already in `.env` is left alone and its step skipped,
 * so this can be re-run to fill in whatever is still missing.
 */

const ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(ROOT, '.env');

function ensureEnvFile(): void {
  if (existsSync(ENV_PATH)) return;
  copyFileSync(resolve(ROOT, '.env.example'), ENV_PATH);
  console.log('  created .env from .env.example\n');
}

/**
 * Rewrites one value in place. Line-based rather than re-serialising a parsed object, because
 * `.env` is also documentation here — every key has a comment above it explaining the choice,
 * and a round trip through a parser would throw all of that away.
 */
function setEnv(key: string, value: string): void {
  const lines = readFileSync(ENV_PATH, 'utf8').split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(ENV_PATH, lines.join('\n'));
  process.env[key] = value;
}

function missing(key: string): boolean {
  return !process.env[key]?.trim();
}

async function askUntilAnswered(rl: Interface, question: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
    console.log('  (that cannot be blank)');
  }
}

/** The one step that cannot be automated: Telegram sends a code to the phone, not to us. */
async function login(rl: Interface): Promise<void> {
  // Held by its concrete type: `client.session` is the base Session, whose `save` returns void.
  const session = new StringSession('');
  const client = new TelegramClient(session, Number(process.env.TG_API_ID), process.env.TG_API_HASH!, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: () => askUntilAnswered(rl, '  Phone number, with country code (+447700900000): '),
    phoneCode: () => askUntilAnswered(rl, '  Code Telegram just sent you: '),
    password: () => rl.question('  Two-factor password (press enter if you have none): '),
    onError: (err) => console.error(`  ${err.message}`),
  });

  const me = (await client.getMe()) as { username?: string };
  // Written straight to the file rather than printed. It is a full credential for the
  // account, and a terminal is a place things get scrolled past and screenshotted.
  setEnv('TG_SESSION', session.save());
  console.log(`\n  ✓ logged in as @${me.username ?? 'your account'} · session saved to .env\n`);
  await client.disconnect();
}

interface Destination {
  title: string;
  id: string;
  username?: string;
  broadcast: boolean;
  /** Whether this account could actually publish here. Non-admin channels are shown greyed. */
  admin: boolean;
}

async function destinations(client: TelegramClient): Promise<Destination[]> {
  const dialogs = await client.getDialogs({ limit: 500 });
  return dialogs
    .filter((d) => d.isChannel || d.isGroup)
    .map((d) => {
      const e = d.entity as Api.Channel | Api.Chat;
      return {
        title: (d.title ?? 'unnamed').slice(0, 40),
        id: (e.id as { toString(): string }).toString(),
        username: (e as Api.Channel).username,
        broadcast: Boolean((e as Api.Channel).broadcast),
        admin: Boolean(e.creator || e.adminRights),
      };
    });
}

/**
 * Picking from a numbered list rather than pasting an id. The `-100` prefix and the bare form
 * are both valid and look nothing alike, so copying one by hand is the step where this goes
 * wrong — and it fails later, as a channel that will not resolve.
 */
async function chooseDestination(rl: Interface, rows: Destination[], prompt: string): Promise<string | undefined> {
  if (!rows.length) return undefined;

  console.log(`\n  ${prompt}\n`);
  rows.forEach((r, i) => {
    const kind = r.broadcast ? 'channel' : 'group';
    const rights = r.admin ? 'admin' : 'not an admin';
    console.log(`  ${String(i + 1).padStart(3)}. ${r.title.padEnd(42)} ${kind.padEnd(8)} ${rights}`);
  });

  const answer = (await rl.question('\n  Number (or enter to skip): ')).trim();
  if (!answer) return undefined;

  const picked = rows[Number(answer) - 1];
  if (!picked) {
    console.log('  that is not one of the numbers above — skipping');
    return undefined;
  }
  if (!picked.admin) {
    console.log(`  ⚠ this account is not an admin of "${picked.title}" — /signal will be ignored there`);
  }
  return picked.username ? `@${picked.username}` : picked.id;
}

async function main() {
  console.log('\n  pumpgod setup · nothing is published, nothing is posted\n');

  ensureEnvFile();
  loadEnv({ override: true });

  const rl = createInterface({ input: stdin, output: stdout });

  // Ctrl-D leaves the pending `question` promise unsettled, so without this the process just
  // ends part-way through with no sign of how far it got. Everything answered is already on
  // disk, which is the thing worth saying.
  let finished = false;
  rl.on('close', () => {
    if (finished) return;
    console.log('\n\n  Stopped. What you answered is saved — re-run `npm run setup` to carry on.\n');
    process.exit(1);
  });

  if (missing('TG_API_ID') || missing('TG_API_HASH')) {
    console.log('  Open https://my.telegram.org → API development tools, and create an app.');
    console.log('  These are for your own account, not a bot: a bot cannot read other groups.\n');
    if (missing('TG_API_ID')) setEnv('TG_API_ID', await askUntilAnswered(rl, '  App api_id: '));
    if (missing('TG_API_HASH')) setEnv('TG_API_HASH', await askUntilAnswered(rl, '  App api_hash: '));
    console.log('');
  }

  if (missing('TG_SESSION')) {
    console.log('  Logging in to Telegram. The code goes to your phone, not here.\n');
    await login(rl);
  }

  if (missing('PUMPGOD_CHANNEL') || missing('WAR_ROOM_CHAT')) {
    const client = new TelegramClient(
      new StringSession(process.env.TG_SESSION!),
      Number(process.env.TG_API_ID),
      process.env.TG_API_HASH!,
      { connectionRetries: 5 },
    );
    await client.connect();

    const rows = await destinations(client);
    if (missing('PUMPGOD_CHANNEL')) {
      const pick = await chooseDestination(rl, rows, 'Which one do calls get published to?');
      if (pick) setEnv('PUMPGOD_CHANNEL', pick);
    }
    if (missing('WAR_ROOM_CHAT')) {
      const pick = await chooseDestination(
        rl,
        rows,
        'And the war room — a private group for refusals and calls held back? (optional)',
      );
      if (pick) setEnv('WAR_ROOM_CHAT', pick);
    }

    await client.disconnect();
  }

  finished = true;
  rl.close();

  const left = ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION', 'PUMPGOD_CHANNEL'].filter(missing);
  if (left.length) {
    console.log(`\n  Still missing: ${left.join(', ')}. Re-run \`npm run setup\` to finish.\n`);
    process.exit(1);
  }

  console.log('\n  ✓ .env is filled in. Next:\n');
  console.log('      npm run doctor      prove the setup before a call depends on it');
  console.log('      npm run dev         then type /signal <address> in your channel\n');
  console.log('  Publishing is off until you set LIVE=true in .env.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ✗ setup could not finish: ${(err as Error).message}\n`);
  process.exit(1);
});
