import { createInterface, type Interface } from 'node:readline/promises';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

interface WatchedSource {
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
export function watchable(rows: Destination[], ours: Array<string | undefined>): Destination[] {
  const mine = ours.map((v) => v?.trim().replace(/^@/, '').toLowerCase()).filter(Boolean) as string[];
  return rows.filter(
    (row) => !mine.includes(row.id.toLowerCase()) && !(row.username && mine.includes(row.username.toLowerCase())),
  );
}

function watchedRefs(existing: WatchedSource[]): Set<string> {
  return new Set(
    existing.flatMap((s) => [s.peerId, s.username?.replace(/^@/, '').toLowerCase()].filter(Boolean) as string[]),
  );
}

function isWatched(row: Destination, refs: Set<string>): boolean {
  return refs.has(row.id) || (!!row.username && refs.has(row.username.toLowerCase()));
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

  const watched = new Set(
    existing.flatMap((s) => [s.peerId, s.username?.replace(/^@/, '').toLowerCase()].filter(Boolean) as string[]),
  );
  const already = (row: Destination) =>
    watched.has(row.id) || (!!row.username && watched.has(row.username.toLowerCase()));

  const candidates = rows.filter((row) => !isOurs(row));
  if (!candidates.length) return;

  console.log('\n  Which groups should we watch? Nothing is ever published from these — they');
  console.log('  are parsed and scored, so you can see who is actually worth relaying.\n');
  candidates.forEach((row, i) => {
    const kind = row.broadcast ? 'channel' : 'group';
    console.log(`  ${String(i + 1).padStart(3)}. ${row.title.padEnd(42)} ${kind.padEnd(8)} ${already(row) ? 'watching' : ''}`);
  });

  const answer = (await rl.question('\n  Numbers, comma-separated (or enter to skip): ')).trim();
  if (!answer) return;

  const taken = new Set(existing.map((s) => s.id));
  const added = candidates
    .filter((_, i) => parseChoices(answer, candidates.length).includes(i))
    .filter((row) => !already(row))
    .map((row): WatchedSource => ({
      id: idFor(row, taken),
      label: row.title,
      ...(row.username ? { username: row.username } : { peerId: row.id }),
      mode: 'shadow',
      enabled: true,
    }));

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

  // One connection answers both halves: where our calls go, and which rooms we read. The
  // watch list is offered every run rather than only on the first, because it is a list that
  // grows — you join another group, you add it — not a value that gets filled in once.
  if (!missing('TG_SESSION')) {
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

  const left = ['TG_API_ID', 'TG_API_HASH', 'TG_SESSION', 'PUMPGOD_CHANNEL'].filter(missing);
  if (left.length) {
    console.log(`\n  Still missing: ${left.join(', ')}. Re-run \`npm run setup\` to finish.\n`);
    process.exit(1);
  }

  console.log('\n  ✓ .env is filled in. Next:\n');
  console.log('      npm run doctor      prove the setup before a call depends on it');
  console.log('      npm run dev         then type /signal <address> in your channel\n');

  // Worth saying plainly, because it is the one thing here that cannot be caught up on later:
  // a group scores only from the day it is listed.
  if (!readSources()?.length) {
    console.log('  No groups are being watched yet. Join a few call groups on this account and');
    console.log('  re-run `npm run setup` — a group is only scored from the day you add it.\n');
  }
  console.log('  Publishing is off until you set LIVE=true in .env.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\n  ✗ setup could not finish: ${(err as Error).message}\n`);
  process.exit(1);
});
