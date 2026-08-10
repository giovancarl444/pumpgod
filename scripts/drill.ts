import { Api, TelegramClient } from 'telegram';
import { loadConfig, loadSources, normalisePeerId, type AppConfig } from '../src/config';
import { createClient, peerIdOf, primeEntityCache, resolveInputPeer } from '../src/telegram/client';
import { attachIngest, type IncomingMessage } from '../src/telegram/ingest';
import { MtprotoTransport, mtprotoPeer } from '../src/telegram/mtproto';
import { sendFast } from '../src/telegram/send';
import { Router, passesFilters } from '../src/pipeline/router';
import { assess } from '../src/pipeline/risk';
import { parseCall } from '../src/parse';
import { Tracker, type Outcome, type TrackedCall } from '../src/track/tracker';
import { journal } from '../src/store/journal';
import type { ParsedCall, Signal, Source } from '../src/types';

/**
 * `npm run doctor` proves the wiring. This proves the engine.
 *
 * It posts a synthetic call into a chat that is configured as a source and then gets out of
 * the way: the message comes back through the real MTProto socket, the real parser reads it,
 * the real screen judges it, the real dedupe admits it and the real publish path sends it.
 * Nothing here reimplements any of that, which is the point — a drill that used its own copy
 * of the pipeline would pass while the engine was broken.
 *
 * The number it produces that no other tool can: how long Telegram actually takes to hand us
 * a message somebody just posted. `npm run bench` measures the parser and the send leg, but
 * both of those start after we already have the message.
 *
 *   npm run drill -- --into <peer>              rehearsal: publishes to the war room
 *   npm run drill -- --into <peer> --publish     the real thing: publishes to the channel
 */

/** How long to give the update socket before falling back to fetching the message back. */
const SOCKET_WAIT_MS = 4_000;

/** How long to wait for the router to reach a decision once it has the message. */
const SETTLE_MS = 20_000;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * A fresh address every run, so dedupe cannot mistake this for a repeat and the tracker
 * cannot confuse it with a coin that exists. The suffix guarantees a digit, an uppercase and
 * a lowercase — what the parser demands before it will believe a base58 run is a Solana mint.
 */
function syntheticAddress(): string {
  let s = '';
  for (let i = 0; i < 40; i++) s += B58[Math.floor(Math.random() * B58.length)];
  return `${s}7Ab`;
}

/** Shaped like the groups we actually track: labelled CA, stats on one line, chart link. */
function drillMessage(mint: string, pool: string): string {
  return [
    'Pumpgod Drill 🧪 | DRILL',
    `CA: ${mint}`,
    '📊 Market Cap: $84.20K 🌐 Solana 💧 Liquidity: $41.30K 📈 Volume: $63.10K ⏰ Token Age: 3h',
    `Chart: https://dexscreener.com/solana/${pool}`,
    'pumpgod drill — synthetic call, not a real token. Deleted automatically.',
  ].join('\n');
}

/**
 * Stands in for the real Tracker purely to watch what the router decided. Overriding `track`
 * without calling super is also what keeps a coin that does not exist out of
 * `data/tracked.json`, which the scorecard is built from.
 */
class DrillWatch extends Tracker {
  readonly seen: Array<{ signal: Signal; outcome: Outcome }> = [];

  override track(signal: Signal, outcome: Outcome): TrackedCall {
    this.seen.push({ signal, outcome });
    // Returned rather than stored, so a caller that decorates the entry — `decline` does —
    // still has something to write to while the drill's fake coin stays out of the scorecard.
    return {
      id: signal.id,
      sourceId: signal.source.id,
      outcome,
      chain: signal.call.token.chain,
      address: signal.call.token.address,
      calledAt: Date.now(),
    };
  }
}

function flagValue(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const exact = argv.indexOf(`--${name}`);
  if (exact >= 0) return argv[exact + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function reason(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return (e.errorMessage ?? e.message ?? String(err)).replace(/\s*\(caused by .*\)$/, '');
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function fail(message: string, hint?: string): number {
  console.log(`\n  ✗ ${message}`);
  if (hint) console.log(`    └ ${hint}`);
  console.log('');
  return 1;
}

function ms(n: number): string {
  return n < 1 ? `${(n * 1000).toFixed(1)}µs` : `${n.toFixed(2)}ms`;
}

function titleOf(entity: Api.TypeChat | Api.TypeUser): string {
  const e = entity as { title?: string; username?: string; firstName?: string };
  return e.title ?? e.username ?? e.firstName ?? 'unnamed';
}

/** Times the screen on its own. The router runs it inline, so it has no separate metric. */
function riskCost(call: ParsedCall): number {
  for (let i = 0; i < 10_000; i++) assess(call);
  const start = performance.now();
  for (let i = 0; i < 100_000; i++) assess(call);
  return (performance.now() - start) / 100_000;
}

async function removeById(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  messageId: number,
  where: string,
): Promise<string> {
  try {
    await client.deleteMessages(peer, [messageId], { revoke: true });
    return `removed from ${where}`;
  } catch (err) {
    return `COULD NOT REMOVE from ${where} — delete message ${messageId} by hand (${reason(err)})`;
  }
}

/**
 * The router does not hand back the id it published, so the drill finds its own message by
 * the synthetic address and never deletes anything it has not first read.
 */
async function removePublished(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  marker: string,
  where: string,
): Promise<string> {
  try {
    const recent = await client.getMessages(peer, { limit: 5 });
    const mine = recent.find((m) => m.message?.includes(marker));
    if (!mine) return `NOT FOUND in ${where} — find the drill call and delete it by hand`;
    return await removeById(client, peer, mine.id, where);
  } catch (err) {
    return `COULD NOT REMOVE from ${where} — delete the drill call by hand (${reason(err)})`;
  }
}

async function main(): Promise<number> {
  const into = flagValue('into');
  const publish = process.argv.includes('--publish');

  console.log('\n─── pumpgod drill ───\n');

  if (!into) {
    return fail(
      'no --into given.',
      'npm run drill -- --into <peer>   (a chat listed as an enabled source in config/sources.json)',
    );
  }

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    return fail(reason(err));
  }

  // Which credential is in use decides whether there is anything here to drill at all, so it
  // is settled before the source list is read. A bot can only see chats it was added to, and
  // nobody adds your bot to their call group — so relaying is not misconfigured on this path,
  // it is impossible. Left to fall through, it surfaces as a missing sources file and a
  // `dialogs` command that needs the very account credential the bot exists to avoid.
  if (config.botToken) {
    return fail(
      'this drill exercises relaying, which a bot cannot do — it only sees chats it was added to.',
      'preview a call with `npm run call -- <address>`, and publish one by typing /signal in the channel',
    );
  }
  if (!config.session) {
    return fail('TG_SESSION is empty.', 'run `npm run setup` and choose the account option — it writes the session for you');
  }

  let sources: Source[];
  try {
    sources = loadSources();
  } catch (err) {
    return fail(reason(err));
  }

  // Everything below this point costs a network round trip, so the message is proven against
  // the parser and the screen first. If the drill call no longer reads as a clean call, that
  // is a real regression and it should be said plainly rather than surfacing as a silent
  // divert twenty seconds later.
  const mint = syntheticAddress();
  const text = drillMessage(mint, syntheticAddress());
  const expected = parseCall(text);
  if (!expected) return fail('the drill message no longer parses as a call.', 'the parser has regressed — run `npm test`');
  if (expected.token.address !== mint) {
    return fail(
      `the parser picked ${expected.token.address.slice(0, 12)}… instead of the CA.`,
      'address ranking has regressed — a pool address is outranking a labelled contract',
    );
  }
  const expectedRisk = assess(expected);
  if (expectedRisk.level !== 'clear') {
    return fail(
      `the drill call now screens as ${expectedRisk.level}: ${expectedRisk.flags.map((f) => f.detail).join('; ')}.`,
      'it would be held back rather than published — fix the thresholds or the drill message',
    );
  }

  const client = createClient(config);
  await client.connect();
  if (!(await client.checkAuthorization())) {
    return fail('TG_SESSION is not authorised any more.', 'run `npm run login` again');
  }
  await primeEntityCache(client);

  let targetPeer: Api.TypeInputPeer;
  try {
    targetPeer = await resolveInputPeer(client, into);
  } catch (err) {
    return fail(`could not resolve --into "${into}": ${reason(err)}`, 'run `npm run dialogs` to list what this account can see');
  }
  const targetId = peerIdOf(targetPeer);
  if (!targetId) return fail(`--into "${into}" is not a chat this can post a call into.`);
  const targetKey = normalisePeerId(targetId);

  // Refusing here is the whole reason this check exists: posting into a chat ingest is not
  // watching would look like a clean run and prove nothing at all.
  const enabled = sources.filter((s) => s.enabled);
  let matched: Source | undefined;
  for (const source of enabled) {
    try {
      const peer = await resolveInputPeer(client, source.peerId ?? source.username!);
      const id = peerIdOf(peer);
      if (id && normalisePeerId(id) === targetKey) {
        matched = source;
        break;
      }
    } catch {
      // A source that will not resolve cannot be the one we are pointing at.
    }
  }
  if (!matched) {
    return fail(
      `${targetKey} is not an enabled source, so ingest would never see the message.`,
      enabled.length
        ? `enabled sources: ${enabled.map((s) => s.id).join(', ')}`
        : 'no enabled sources in config/sources.json',
    );
  }

  // The drill call is a solana mint, so a CHAINS list without solana drops it in the router
  // before any of this is exercised. Same reasoning as the source check above: a run that
  // proves nothing must not be allowed to look like a clean one.
  if (config.chains.length && !config.chains.includes('solana')) {
    return fail(
      `CHAINS is set to ${config.chains.join('/')}, and the drill call is solana — the router would drop it.`,
      'set CHAINS=solana (or CHAINS=all) in .env to run the drill',
    );
  }

  if (!passesFilters(matched, expected)) {
    return fail(
      `source "${matched.id}" filters this call out before it reaches the pipeline.`,
      `the drill call is solana at $84.2K — check chains / minMarketCapUsd / maxMarketCapUsd on that source`,
    );
  }

  const destination = publish ? config.channel : config.warRoom;
  if (!destination) {
    return publish
      ? fail('PUMPGOD_CHANNEL is unset, so --publish has nowhere to go.')
      : fail(
          'WAR_ROOM_CHAT is unset, so the rehearsal has nowhere to publish.',
          'set WAR_ROOM_CHAT in .env, or pass --publish to post to the channel for real',
        );
  }

  let destPeer: Api.TypeInputPeer;
  try {
    destPeer = await resolveInputPeer(client, destination);
  } catch (err) {
    return fail(`could not resolve the publish destination "${destination}": ${reason(err)}`);
  }

  const targetName = titleOf(await client.getEntity(targetPeer));
  const destName = titleOf(await client.getEntity(destPeer));

  // Forced to auto because a review source would sit waiting for a human tap and prove
  // nothing about the publish path. Every other gate the source carries is left alone.
  const drillSource: Source = { ...matched, id: 'drill', label: `drill via ${matched.label}`, mode: 'auto' };

  // Enrichment is off: the token does not exist, so DexScreener would time out and then edit
  // the message, and the timings would be measuring a failed lookup.
  const drillConfig: AppConfig = { ...config, live: true, enrichEnabled: false };

  const watch = new DrillWatch();
  const router = new Router(new MtprotoTransport(client), drillConfig, mtprotoPeer(destPeer), undefined, watch);

  let detected: IncomingMessage | undefined;
  const onUpdate = attachIngest(client, new Map([[targetKey, drillSource]]), {}, {
    onMessage: (msg) => {
      // Matched on the address rather than the message id: the update can arrive before the
      // send RPC has returned the id it was given.
      if (detected || !msg.text.includes(mint)) return;
      detected = msg;
      router.handleMessage(msg);
    },
    onReaction: () => undefined,
    onCommand: () => undefined,
  });

  console.log(`  posting into   ${targetName}  (source "${matched.id}", mode ${matched.mode})`);
  console.log(`  publishing to  ${destName}${publish ? '  ← THE PUBLIC CHANNEL' : '  (rehearsal — pass --publish for the channel)'}`);
  console.log(`  token          ${mint}`);
  console.log('');
  console.log(`  Both messages are deleted at the end. If the engine is running it will see`);
  console.log(`  this call too, and may publish it a second time.\n`);

  const post = await sendFast(client, targetPeer, text, { stage: 'drill.post', silent: true });
  if (!post.messageId) {
    await client.disconnect();
    return fail('the post was accepted but Telegram returned no message id, so nothing can be cleaned up.');
  }

  let code = 0;
  try {
    const deadline = Date.now() + SOCKET_WAIT_MS;
    while (!detected && Date.now() < deadline) await sleep(20);

    const path = detected ? 'socket' : 'replay';
    if (!detected) {
      // Telegram does not push a message back down to the session that sent it — the reply to
      // the send carries it instead. Fetching it and pushing it through the handler ingest
      // registered keeps every stage after delivery identical; only the socket leg is missing.
      const [message] = await client.getMessages(targetPeer, { ids: [post.messageId] });
      if (!(message instanceof Api.Message)) {
        return fail('posted, but the message could not be read back.', 'is this account still able to read that chat?');
      }
      onUpdate(
        targetPeer instanceof Api.InputPeerChannel
          ? new Api.UpdateNewChannelMessage({ message, pts: 0, ptsCount: 0 })
          : new Api.UpdateNewMessage({ message, pts: 0, ptsCount: 0 }),
      );
    }

    if (!detected) {
      return fail(
        'the message never reached ingest.',
        'the raw-update handler rejected it — check that the chat id matches the source',
      );
    }

    const settle = Date.now() + SETTLE_MS;
    while (!watch.seen.length && Date.now() < settle) await sleep(20);

    const decision = watch.seen[0];
    if (!decision) {
      return fail(
        'ingest and the parser worked, but the router never reached a decision.',
        'the call was most likely diverted to review, which needs a war room the drill does not give it',
      );
    }

    const { signal, outcome } = decision;
    const t = signal.timings;

    console.log(`  ingest         ${path === 'socket' ? 'socket — pushed to us by Telegram' : 'replay — fetched back (Telegram does not echo our own send)'}`);
    console.log(`  parsed         $${signal.call.ticker} · ${signal.call.token.chain} · ${signal.call.token.origin} ${Math.round(signal.call.token.confidence * 100)}%`);
    console.log(`  screened       ${signal.risk.level}`);
    console.log(`  routed         ${outcome}${signal.stale ? ` · stale (${signal.ageSec}s)` : ''}`);
    console.log('');

    const rows: Array<[string, string, string?]> = [];
    if (path === 'socket') {
      rows.push(['post dispatched → detected', ms(t.recvAt - post.dispatchAt), 'our post, Telegram, back to us']);
    }
    rows.push(['detected → parsed', t.parsedAt ? ms(t.parsedAt - t.recvAt) : '—']);
    rows.push(['risk screen', ms(riskCost(signal.call)), 'measured separately; runs inside the leg below']);
    if (t.parsedAt && t.dispatchAt) rows.push(['parsed → dispatched', ms(t.dispatchAt - t.parsedAt), 'dedupe, screen, render']);
    if (t.dispatchAt && t.ackAt) rows.push(['dispatched → acked', ms(t.ackAt - t.dispatchAt), 'pure network']);

    const width = Math.max(...rows.map((r) => r[0].length));
    console.log(`  ${'stage'.padEnd(width)}   ${'time'.padStart(9)}`);
    console.log(`  ${'─'.repeat(width + 12)}`);
    for (const [label, value, note] of rows) {
      console.log(`  ${label.padEnd(width)}   ${value.padStart(9)}${note ? `   ${note}` : ''}`);
    }
    console.log(`  ${'─'.repeat(width + 12)}`);

    if (t.ackAt) {
      console.log(`  ${'detected → acked'.padEnd(width)}   ${ms(t.ackAt - t.recvAt).padStart(9)}   end to end, everything we control`);
    } else {
      console.log(`  nothing was published — the router chose "${outcome}"`);
      code = 1;
    }
    console.log('');

    if (outcome !== 'called') {
      console.log(`  ⚠  the router recorded this as "${outcome}", not "called".\n`);
      code = 1;
    }
  } finally {
    // In a finally so a drill that fails half way through still takes its litter with it.
    const notes = [await removeById(client, targetPeer, post.messageId, targetName)];
    if (watch.seen.length) notes.push(await removePublished(client, destPeer, mint, destName));
    for (const note of notes) console.log(`  cleanup        ${note}`);
    console.log('');
    journal.close();
    await client.disconnect();
  }

  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  ✗ drill failed: ${reason(err)}\n`);
    process.exit(1);
  });
