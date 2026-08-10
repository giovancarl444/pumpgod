import { loadConfig, loadSources, normalisePeerId } from './config';
import { createClient, primeEntityCache, resolveInputPeer, peerIdOf } from './telegram/client';
import { attachIngest } from './telegram/ingest';
import { Router } from './pipeline/router';
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
  for (const source of sources) {
    try {
      const peer = source.peerId
        ? await resolveInputPeer(client, source.peerId)
        : await resolveInputPeer(client, source.username!);
      const id = peerIdOf(peer);
      if (!id) throw new Error('unsupported peer type');
      watched.set(normalisePeerId(id), source);
      log.info(`watching ${source.label} [${source.mode}] → ${id}`);
    } catch (err) {
      log.error(`could not resolve source "${source.id}": ${(err as Error).message}`);
    }
  }

  if (!watched.size) throw new Error('No sources could be resolved. Is this account a member of those groups?');

  const router = new Router(client, config, channelPeer, warRoomPeer);

  attachIngest(client, watched, warRoomId, {
    onMessage: (msg) => router.handleMessage(msg),
    onReaction: (reaction) => router.handleReaction(reaction),
  });

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
    log.info('shutting down');
    log.info(formatSnapshot());
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
