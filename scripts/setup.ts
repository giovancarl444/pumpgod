import { createInterface, type Interface } from 'node:readline/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { config as loadEnv } from 'dotenv';
import { normalisePeerId } from '../src/config';
import { BotApi, botRights, chatIdFor, type BotChat, type ChatMember } from '../src/telegram/botapi';

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
const SOURCES_PATH = resolve(ROOT, 'config/sources.json');

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

type Mode = 'bot' | 'account';

/**
 * Which of the two credentials this run is filling in.
 *
 * They are not a pair and not a ladder — a bot publishes and can never read a rival group, an
 * account can read and is bannable. Most people want the bot: it is a token pasted from a
 * chat window versus a developer app and a login code, and it is the half that has to work
 * before anything can be published at all.
 */
async function chooseMode(rl: Interface): Promise<Mode> {
  if (!missing('TG_BOT_TOKEN')) return 'bot';
  if (!missing('TG_SESSION')) return 'account';

  console.log('  Two ways to connect, and they do different jobs.\n');
  console.log('    1. A bot          publishes your calls. No phone number, nothing tied to your');
  console.log('                      own account. About a minute.  ← start here');
  console.log('    2. Your account   also reads other groups, which is the only way to score them.');
  console.log('                      Needs my.telegram.org and a code sent to your phone.\n');

  const answer = (await rl.question('  Number [1]: ')).trim();
  return answer === '2' ? 'account' : 'bot';
}

/**
 * Naming a chat to a bot, which has no dialog list to pick from — it can only be told, and it
 * can only see chats it was added to. So the answer is typed, and then proven: `getChat` says
 * whether it can see the chat at all, `getChatMember` says whether it may publish there. Both
 * failures are worth catching here rather than at the first real call.
 */
async function askChat(
  rl: Interface,
  api: BotApi,
  botId: number,
  prompt: string,
  optional = false,
): Promise<string | undefined> {
  for (;;) {
    const answer = (await rl.question(prompt)).trim();
    if (!answer) {
      if (optional) return undefined;
      console.log('  (that cannot be blank)');
      continue;
    }

    try {
      const chat = await api.call<BotChat>('getChat', { chat_id: chatIdFor(answer) });
      const member = await api.call<ChatMember>('getChatMember', { chat_id: chat.id, user_id: botId });
      const rights = botRights(chat.type, member);
      console.log(`  ${rights.ok ? '✓' : '⚠'} ${chat.title ?? answer} · ${rights.detail}`);
      if (rights.hint) console.log(`    └ ${rights.hint}`);
      // Stored as the numeric id: it is what every reply comes tagged with, and unlike a
      // @username it survives the channel being renamed.
      return String(chat.id);
    } catch (err) {
      console.log(`  ✗ ${(err as Error).message}`);
      console.log('    └ add the bot to that chat first, as an admin — then paste it again');
      console.log('      (or press enter to skip, and set it in .env by hand later)');
      if (optional) return undefined;
    }
  }
}

/**
 * The bot half of setup. No source list is offered, and there is nothing missing: a bot cannot
 * join a group on its own, so it will never see a rival's calls however this is configured.
 */
async function botSetup(rl: Interface): Promise<void> {
  if (missing('TG_BOT_TOKEN')) {
    console.log('\n  In Telegram, message @BotFather and send /newbot. It asks for a name and a');
    console.log('  username, then gives you a token like 8123456789:AAH… — paste that here.\n');
    console.log('  Written straight to .env, which is gitignored. Anyone holding it owns the bot.\n');
    setEnv('TG_BOT_TOKEN', await askUntilAnswered(rl, '  Bot token: '));
  }

  const api = new BotApi(process.env.TG_BOT_TOKEN!);
  const me = await api.call<{ id: number; username?: string }>('getMe');
  const handle = me.username ? `@${me.username}` : 'your bot';
  console.log(`\n  ✓ that token is ${handle}\n`);

  if (missing('PUMPGOD_CHANNEL')) {
    console.log(`  Where do calls get published? Add ${handle} to that channel as an admin first`);
    console.log('  — a bot cannot join anything by itself, and cannot see a chat it is not in.\n');
    const picked = await askChat(rl, api, me.id, '  Channel @username or -100… id: ');
    if (picked) setEnv('PUMPGOD_CHANNEL', picked);
  }

  if (missing('WAR_ROOM_CHAT')) {
    console.log('\n  And a war room — a private group where risky calls wait for a 🚀 from you');
    console.log('  instead of going straight out. Optional; press enter to skip.\n');
    const picked = await askChat(rl, api, me.id, '  War room @username or -100… id: ', true);
    if (picked) setEnv('WAR_ROOM_CHAT', picked);
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

export interface Destination {
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
async function chooseDestination(rl: Interface, rows: Destination[], prompt: string): Promise<Destination | undefined> {
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
  return picked;
}

/** How `config/sources.json` refers to a chat. A username survives the group changing id. */
function peerRef(row: Destination): string {
  return row.username ? `@${row.username}` : row.id;
}

export interface WatchedSource {
  id: string;
  label: string;
  username?: string;
  peerId?: string;
  mode: 'auto' | 'review' | 'shadow';
  enabled: boolean;
}

const SOURCES_HEADER = [
  'The groups this account reads. `npm run setup` appends to it; edit by hand after that.',
  '',
  'mode:',
  '  auto   - publish straight to the channel, no human step. Only for sources you trust.',
  '  review - post to the war room and wait for a 🚀 reaction before publishing.',
  '  shadow - parse and score, never surface. Everything starts here.',
];

/**
 * `undefined` means the file is there but will not parse. That must never be overwritten: it
 * is hand-edited, so a bad parse is a typo to go and fix, not a reason to throw the list away.
 */
function readSources(): WatchedSource[] | undefined {
  if (!existsSync(SOURCES_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SOURCES_PATH, 'utf8')) as { sources?: unknown };
    return Array.isArray(parsed.sources) ? (parsed.sources as WatchedSource[]) : undefined;
  } catch {
    return undefined;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
}

/**
 * Written once and never regenerated. The ratings table keys a group's anonymous label off
 * this id, so an id that moves makes the table uncomparable week to week — which is the only
 * thing the table is for. Prefers the @username, which outlives the group being renamed.
 */
function idFor(row: Destination, taken: Set<string>): string {
  const base = row.username?.toLowerCase() || slug(row.title) || `group-${row.id}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Everything this account can read except our own rooms. Watching our own channel would feed
 * our published calls back in as though another group had made them — inflating the very
 * table that is supposed to compare us against them.
 */
/**
 * One chat written any of the ways this project accepts. Telegram's own UI shows a channel as
 * -100xxxxxxxxxx while the wire protocol uses the bare id, and `.env` and `config/sources.json`
 * both take either — `loadSources` normalises on the way in. Matching on the raw string here
 * instead would make a hand-written -100 id look like a different chat from the same chat
 * listed by `getDialogs`, which is how our own channel gets offered as a group to watch.
 */
function peerKey(value: string | undefined): string | undefined {
  const bare = value?.trim().replace(/^@/, '').toLowerCase();
  return bare ? normalisePeerId(bare) : undefined;
}

export function watchable(rows: Destination[], ours: Array<string | undefined>): Destination[] {
  const mine = new Set(ours.map(peerKey).filter(Boolean) as string[]);
  return rows.filter((row) => !isSameChat(row, mine));
}

function watchedRefs(existing: WatchedSource[]): Set<string> {
  return new Set(existing.flatMap((s) => [peerKey(s.peerId), peerKey(s.username)].filter(Boolean) as string[]));
}

function isWatched(row: Destination, refs: Set<string>): boolean {
  return isSameChat(row, refs);
}

function isSameChat(row: Destination, keys: Set<string>): boolean {
  return keys.has(normalisePeerId(row.id)) || (!!row.username && keys.has(row.username.toLowerCase()));
}

export function parseChoices(answer: string, max: number): number[] {
  const asked = answer.split(/[\s,]+/).filter(Boolean).map(Number);
  return [...new Set(asked)].filter((n) => Number.isInteger(n) && n >= 1 && n <= max).map((n) => n - 1);
}

/**
 * What picking these rows adds to `config/sources.json`. A group already listed is skipped
 * rather than restated, so re-running setup after joining a few more is safe — and nothing
 * already in the file is rewritten, because by then it has been hand-edited.
 */
export function additions(picked: Destination[], existing: WatchedSource[]): WatchedSource[] {
  const refs = watchedRefs(existing);
  const taken = new Set(existing.map((s) => s.id));

  return picked
    .filter((row) => !isWatched(row, refs))
    .map((row) => ({
      id: idFor(row, taken),
      label: row.title,
      ...(row.username ? { username: row.username } : { peerId: row.id }),
      mode: 'shadow' as const,
      enabled: true,
    }));
}

/**
 * The half of setup that `.env` cannot hold: which rooms we read.
 *
 * Everything picked here starts in `shadow` — parsed and scored, never published. That is the
 * only honest way to find out whether a group is worth relaying, and those records are what
 * the public ratings table is built from, so the sooner a group is listed the sooner it can be
 * ranked. Nothing accumulates retroactively.
 */
async function chooseSources(rl: Interface, rows: Destination[]): Promise<void> {
  const existing = readSources();
  if (!existing) {
    console.log('\n  config/sources.json is there but will not parse — leaving it untouched.\n');
    return;
  }

  const candidates = watchable(rows, [process.env.PUMPGOD_CHANNEL, process.env.WAR_ROOM_CHAT]);
  if (!candidates.length) return;

  const refs = watchedRefs(existing);
  console.log('\n  Which groups should we watch? Nothing is ever published from these — they');
  console.log('  are parsed and scored, so you can see who is actually worth relaying.\n');
  candidates.forEach((row, i) => {
    const kind = row.broadcast ? 'channel' : 'group';
    const mark = isWatched(row, refs) ? 'watching' : '';
    console.log(`  ${String(i + 1).padStart(3)}. ${row.title.padEnd(42)} ${kind.padEnd(8)} ${mark}`);
  });

  const answer = (await rl.question('\n  Numbers, comma-separated (or enter to skip): ')).trim();
  if (!answer) return;

  const picked = parseChoices(answer, candidates.length).map((i) => candidates[i]!);
  const added = additions(picked, existing);

  if (!added.length) {
    console.log('  nothing new to add.\n');
    return;
  }

  mkdirSync(dirname(SOURCES_PATH), { recursive: true });
  writeFileSync(SOURCES_PATH, `${JSON.stringify({ _comment: SOURCES_HEADER, sources: [...existing, ...added] }, null, 2)}\n`);
  const total = existing.length + added.length;
  console.log(`\n  ✓ config/sources.json — ${added.length} added in shadow mode, ${total} watched in total\n`);
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

  const mode = await chooseMode(rl);

  if (mode === 'bot') await botSetup(rl);

  if (mode === 'account' && (missing('TG_API_ID') || missing('TG_API_HASH'))) {
    console.log('\n  Open https://my.telegram.org → API development tools, and create an app.');
    console.log('  These are for your own account, not a bot: a bot cannot read other groups.\n');
    if (missing('TG_API_ID')) setEnv('TG_API_ID', await askUntilAnswered(rl, '  App api_id: '));
    if (missing('TG_API_HASH')) setEnv('TG_API_HASH', await askUntilAnswered(rl, '  App api_hash: '));
    console.log('');
  }

  if (mode === 'account' && missing('TG_SESSION')) {
    console.log('  Logging in to Telegram. The code goes to your phone, not here.\n');
    await login(rl);
  }

  // One connection answers both halves: where our calls go, and which rooms we read. The
  // watch list is offered every run rather than only on the first, because it is a list that
  // grows — you join another group, you add it — not a value that gets filled in once.
  if (mode === 'account' && !missing('TG_SESSION')) {
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
      if (pick) setEnv('PUMPGOD_CHANNEL', peerRef(pick));
    }
    if (missing('WAR_ROOM_CHAT')) {
      const pick = await chooseDestination(
        rl,
        rows,
        'And the war room — a private group for refusals and calls held back? (optional)',
      );
      if (pick) setEnv('WAR_ROOM_CHAT', peerRef(pick));
    }

    await chooseSources(rl, rows);
    await client.disconnect();
  }

  finished = true;
  rl.close();

  const needed =
    mode === 'bot' ? ['TG_BOT_TOKEN', 'PUMPGOD_CHANNEL'] : ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION', 'PUMPGOD_CHANNEL'];
  const left = needed.filter(missing);
  if (left.length) {
    console.log(`\n  Still missing: ${left.join(', ')}. Re-run \`npm run setup\` to finish.\n`);
    process.exit(1);
  }

  console.log('\n  ✓ .env is filled in. Next:\n');
  console.log('      npm run doctor      prove the setup before a call depends on it');
  console.log('      npm run dev         then type /signal <address> in your channel\n');

  // Worth saying plainly, because it is the one thing here that cannot be caught up on later:
  // a group scores only from the day it is listed.
  if (mode === 'bot') {
    console.log('  Nothing is being watched, and a bot cannot be: it only ever sees chats it was');
    console.log('  added to. To rank other groups, re-run this and pick 2 to add a reading');
    console.log('  account — the bot keeps the channel, so a ban there cannot take it down.\n');
  } else if (!readSources()?.length) {
    console.log('  No groups are being watched yet. Join a few call groups on this account and');
    console.log('  re-run `npm run setup` — a group is only scored from the day you add it.\n');
  }
  console.log('  Publishing is off until you set LIVE=true in .env.\n');
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\n  ✗ setup could not finish: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
