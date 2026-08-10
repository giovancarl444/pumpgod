import { loadConfig, loadSources, normalisePeerId } from './config';
import { createClient, primeEntityCache, resolveInputPeer, peerIdOf } from './telegram/client';
import { attachIngest } from './telegram/ingest';
import { Catchup, type WatchedPeer } from './telegram/catchup';
import { Tracker } from './track/tracker';
import { Router } from './pipeline/router';
import { parseCommand, resolveManualCall } from './pipeline/manual';
import { sendFast } from './telegram/send';
import { escapeHtml } from './format/call';
import { formatSnapshot } from './metrics/latency';
import { journal } from './store/journal';
import { log } from './log';
import type { Source } from './types';

async function main() {
  const config = loadConfig();
  if (!config.session) {
    throw new Error('TG_SESSION is empty. Run `npm run login` to create one, then paste it into .env.');
  }

  const sources = loadSources().filter((s) => s.enabled);
  if (!sources.length) throw new Error('No enabled sources in config/sources.json.');

  const client = createClient(config);
  await client.connect();

  if (!(await client.checkAuthorization())) {
    throw new Error('TG_SESSION is not authorised any more. Run `npm run login` again.');
  }

  const me = await client.getMe();
  log.info(`connected as @${(me as { username?: string }).username ?? 'unknown'}`);

  await primeEntityCache(client);

  const channelPeer = config.channel ? await resolveInputPeer(client, config.channel) : undefined;
  const warRoomPeer = config.warRoom ? await resolveInputPeer(client, config.warRoom) : undefined;
  const warRoomId = warRoomPeer ? peerIdOf(warRoomPeer) : undefined;

  // Resolving every source up front means the hot path is a single Map lookup on an id
  // we already hold, with no chance of a mid-call network resolution.
  const watched = new Map<string, Source>();
  const peers = new Map<string, WatchedPeer>();
  for (const source of sources) {
    try {
      const peer = source.peerId
        ? await resolveInputPeer(client, source.peerId)
        : await resolveInputPeer(client, source.username!);
      const id = peerIdOf(peer);
      if (!id) throw new Error('unsupported peer type');
      const key = normalisePeerId(id);
      watched.set(key, source);
      peers.set(key, { source, peer });
      log.info(`watching ${source.label} [${source.mode}] → ${id}`);
    } catch (err) {
      log.error(`could not resolve source "${source.id}": ${(err as Error).message}`);
    }
  }

  if (!watched.size) throw new Error('No sources could be resolved. Is this account a member of those groups?');

  const tracker = new Tracker();
  tracker.load();
  tracker.start(config.trackIntervalMs);

  const router = new Router(client, config, channelPeer, warRoomPeer, tracker);
  const catchup = new Catchup(client);
  catchup.load();

  // `call <address>` in the war room publishes a coin of our own.
  const say = async (text: string) => {
    if (!warRoomPeer) return;
    await sendFast(client, warRoomPeer, text, { stage: 'send.warroom' }).catch(() => undefined);
  };

  const handleCommand = async (cmd: { text: string; recvAt: number }) => {
    const argument = parseCommand(cmd.text);
    if (!argument) return;

    // Resolving market data first is what makes this callable at all: an address on its own
    // has no numbers for the screen to read. Nobody is being raced, so the hop is free.
    const outcome = await resolveManualCall(argument, Math.max(config.enrichTimeoutMs, 5000));
    if (!outcome.ok) {
      log.warn(`manual call rejected: ${outcome.reason}`);
      await say(`✗ ${escapeHtml(outcome.reason)}`);
      return;
    }

    router.callManual(outcome.call, cmd.text, cmd.recvAt);
    if (!config.live) await say('🔇 LIVE=false — nothing was published.');
  };

  attachIngest(client, watched, warRoomId, {
    onMessage: (msg) => {
      catchup.note(msg.chatId, msg.messageId);
      router.handleMessage(msg);
    },
    onReaction: (reaction) => router.handleReaction(reaction),
    onCommand: (cmd) => void handleCommand(cmd),
  });

  // Anything that arrived while the socket was down is replayed here. Recovered calls are
  // stale by definition, so the router sends them to review rather than publishing them.
  const runCatchup = async () => {
    try {
      for (const missed of await catchup.sweep(peers)) router.handleMessage(missed);
    } catch (err) {
      log.warn(`catchup sweep failed: ${(err as Error).message}`);
    }
  };
  await runCatchup();
  const catchupTimer = setInterval(runCatchup, config.catchupIntervalMs);

  log.info(
    `pumpgod live · ${watched.size} sources · publishing ${config.live ? 'ENABLED' : 'DISABLED (LIVE=false)'}`,
  );
  if (!config.live) log.warn('LIVE=false — calls are logged but never posted. Flip LIVE=true when ready.');

  const metrics = setInterval(() => {
    router.sweep();
    log.info(formatSnapshot());
  }, config.metricsIntervalMs);

  const shutdown = async () => {
    clearInterval(metrics);
    clearInterval(catchupTimer);
    log.info('shutting down');
    log.info(formatSnapshot());
    // Persisting the cursors is what lets the next start recover the gap it left behind.
    catchup.persist();
    tracker.stop();
    journal.close();
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
