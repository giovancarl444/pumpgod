import { loadConfig, loadSocial, loadSources, normalisePeerId } from './config';
import { Poster } from './social/poster';
import { createClient, primeEntityCache, resolveInputPeer, peerIdOf } from './telegram/client';
import { attachIngest, type IncomingCommand } from './telegram/ingest';
import { AdminCheck, deleteMessage } from './telegram/admin';
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
  const channelId = channelPeer ? peerIdOf(channelPeer) : undefined;

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

  // `/signal <address>` publishes a coin of our own.
  const admins = new AdminCheck(client, channelPeer);

  // The war room takes every reply it can, because the public channel should carry calls and
  // nothing else — a member scrolling past "✗ no pool found" learns only that we fumbled.
  // With no war room configured there is nowhere else to answer, and silence after a command
  // that deleted itself is worse than the clutter, so it goes back to the channel.
  const say = async (text: string, cmd?: IncomingCommand) => {
    const peer = warRoomPeer ?? (cmd?.fromChannel ? channelPeer : undefined);
    if (!peer) return;
    await sendFast(client, peer, text, { stage: 'send.warroom' }).catch(() => undefined);
  };

  const handleCommand = async (cmd: IncomingCommand) => {
    const argument = parseCommand(cmd.text);
    if (!argument) return;

    if (cmd.fromChannel) {
      if (!(await admins.allows(cmd))) {
        log.warn(`ignored /signal from a non-admin in the channel (${cmd.fromId ?? 'unknown'})`);
        return;
      }
      // Take the instruction down first. If resolving is slow, the channel should not be
      // sitting there showing the command while it waits.
      if (channelPeer) {
        await deleteMessage(client, channelPeer, cmd.messageId).catch((err: Error) =>
          log.debug(`could not delete the command message: ${err.message}`),
        );
      }
    }

    // Resolving market data first is what makes this callable at all: an address on its own
    // has no numbers for the screen to read. Nobody is being raced, so the hop is free.
    const outcome = await resolveManualCall(argument, Math.max(config.enrichTimeoutMs, 5000), config.chains);
    if (!outcome.ok) {
      log.warn(`manual call rejected: ${outcome.reason}`);
      await say(`✗ ${escapeHtml(outcome.reason)}`, cmd);
      return;
    }

    const ticker = outcome.call.ticker ? `$${escapeHtml(outcome.call.ticker)}` : 'that coin';
    const decision = router.callManual(outcome.call, cmd.text, cmd.recvAt);

    // Every branch answers. The command deleted itself on the way in, so an unreported
    // decision leaves an admin unable to tell a screened coin from a bot that has died.
    switch (decision.kind) {
      case 'publishing':
        if (!config.live) await say(`🔇 LIVE=false — ${ticker} was not published.`, cmd);
        break;
      case 'review':
        await say(
          `⚠️ ${ticker} was held back: ${escapeHtml(decision.reason)}.` +
            (warRoomPeer ? ' Tap 🚀 on the card below to publish it anyway.' : ''),
          cmd,
        );
        break;
      case 'duplicate':
        await say(`↩︎ ${ticker} was already called (${escapeHtml(decision.sources.join(', '))}).`, cmd);
        break;
      case 'dropped':
        await say(`✗ ${ticker}: ${escapeHtml(decision.reason)}`, cmd);
        break;
    }
  };

  attachIngest(client, watched, { warRoomId, channelId }, {
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

  // Growth runs off the tracker rather than the call path: a call is worth posting about
  // once it has *done* something, which is minutes to hours after it was published.
  const social = loadSocial();
  const poster = new Poster({ ...social, dailyRecap: social.dailyRecap });
  poster.load();

  let socialTimer: NodeJS.Timeout | undefined;
  if (poster.enabled && config.live) {
    socialTimer = setInterval(() => void poster.run(Tracker.read()), social.postIntervalMs);
    log.info(`𝕏 recap feed on · posting calls that reach ${social.minMultiple}x`);
  } else if (poster.enabled) {
    log.warn('𝕏 credentials set but LIVE=false — nothing will be posted. Preview with `npm run recap`.');
  }

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
    if (socialTimer) clearInterval(socialTimer);
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
