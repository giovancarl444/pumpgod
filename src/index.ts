import { existsSync } from 'node:fs';
import { loadConfig, loadSocial, loadSources, normalisePeerId, SOURCES_PATH, type AppConfig } from './config';
import { Poster } from './social/poster';
import { createClient, primeEntityCache, resolveInputPeer, peerIdOf } from './telegram/client';
import { MtprotoTransport } from './telegram/mtproto';
import { BotApi, BotTransport } from './telegram/botapi';
import { BotAdmins, startBotIngest } from './telegram/botingest';
import { attachIngest } from './telegram/ingest';
import { AdminCheck } from './telegram/admin';
import { Catchup, type WatchedPeer } from './telegram/catchup';
import { Tracker } from './track/tracker';
import { Router } from './pipeline/router';
import { createCommandHandler } from './pipeline/command';
import { formatSnapshot } from './metrics/latency';
import { journal } from './store/journal';
import { log } from './log';
import type { Source } from './types';

async function main() {
  const config = loadConfig();
  if (config.botToken) return runBot(config);

  // Relaying and calling coins ourselves are independent halves, so a missing sources file is
  // a shape this can legitimately run in rather than an error: `/signal` needs a channel, not
  // a list of groups to follow. A file that exists and is malformed still throws — that is a
  // mistake, not a choice.
  const sources = (existsSync(SOURCES_PATH) ? loadSources() : []).filter((s) => s.enabled);
  if (!sources.length && !config.channel) {
    throw new Error(
      'Nothing to do: no enabled sources in config/sources.json, and no PUMPGOD_CHANNEL to publish /signal calls into.',
    );
  }

  const client = createClient(config);
  await client.connect();

  if (!(await client.checkAuthorization())) {
    throw new Error('TG_SESSION is not authorised any more. Run `npm run login` again.');
  }

  const me = await client.getMe();
  log.info(`connected as @${(me as { username?: string }).username ?? 'unknown'}`);

  await primeEntityCache(client);

  const transport = new MtprotoTransport(client);
  const channelPeer = config.channel ? await transport.resolve(config.channel) : undefined;
  const warRoomPeer = config.warRoom ? await transport.resolve(config.warRoom) : undefined;
  const warRoomId = warRoomPeer?.id;
  const channelId = channelPeer?.id;

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

  // Every source failing when some were configured is a different situation from configuring
  // none: something is wrong rather than absent, and it should not be discovered by noticing
  // that nothing was ever relayed.
  if (!watched.size && sources.length) {
    throw new Error('No sources could be resolved. Is this account a member of those groups?');
  }
  if (!watched.size) log.warn('watching no groups — /signal still works, relaying does not');

  const tracker = new Tracker();
  tracker.load();
  tracker.start(config.trackIntervalMs);

  const router = new Router(transport, config, channelPeer, warRoomPeer, tracker);
  const catchup = new Catchup(client);
  catchup.load();

  // `/signal <address>` publishes a coin of our own.
  const handleCommand = createCommandHandler({
    transport,
    config,
    router,
    admins: new AdminCheck(client, channelPeer?.input),
    channelPeer,
    warRoomPeer,
  });

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

/**
 * Bot mode: publishes, and reads nothing but the two chats it was told about.
 *
 * There is no source list here and there cannot be one — a bot can only be *added* to a group
 * by an admin of that group, so it will never see a rival's calls. Relaying and the ratings
 * table need the user-account path. What this does give up nothing on is `/signal`, which is
 * how our own calls are made, and it does it without a phone number attached to the channel.
 */
async function runBot(config: AppConfig) {
  if (!config.channel) {
    throw new Error('PUMPGOD_CHANNEL is empty — a bot has nowhere to publish. Run `npm run setup`.');
  }

  const api = new BotApi(config.botToken);
  const transport = new BotTransport(api);

  const me = await api.call<{ username?: string }>('getMe');
  log.info(`connected as @${me.username ?? 'unknown'} (bot)`);

  // The topic rides on the peer rather than on the id, because a group with Topics turned on
  // is still one chat — the thread only decides where inside it a message lands.
  const channelPeer = { ...(await transport.resolve(config.channel)), threadId: config.channelTopic };
  const warRoomPeer = config.warRoom
    ? { ...(await transport.resolve(config.warRoom)), threadId: config.warRoomTopic }
    : undefined;

  const tracker = new Tracker();
  tracker.load();
  tracker.start(config.trackIntervalMs);

  const router = new Router(transport, config, channelPeer, warRoomPeer, tracker);
  const handleCommand = createCommandHandler({
    transport,
    config,
    router,
    admins: new BotAdmins(api, channelPeer.id),
    channelPeer,
    warRoomPeer,
  });

  const ingest = startBotIngest(
    api,
    { channelId: channelPeer.id, warRoomId: warRoomPeer?.id },
    { onCommand: (cmd) => void handleCommand(cmd), onReaction: (r) => router.handleReaction(r) },
  );

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

  log.info(`pumpgod live · bot mode · publishing ${config.live ? 'ENABLED' : 'DISABLED (LIVE=false)'}`);
  if (!config.live) log.warn('LIVE=false — calls are logged but never posted. Flip LIVE=true when ready.');
  log.info('type /signal <address> in the channel or the war room to call a coin');

  const metrics = setInterval(() => {
    router.sweep();
    log.info(formatSnapshot());
  }, config.metricsIntervalMs);

  const shutdown = () => {
    clearInterval(metrics);
    if (socialTimer) clearInterval(socialTimer);
    ingest.stop();
    log.info('shutting down');
    log.info(formatSnapshot());
    tracker.stop();
    journal.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
