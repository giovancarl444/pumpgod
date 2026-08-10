import { loadConfig } from '../src/config';
import { createClient } from '../src/telegram/client';

/** Prints every chat this account can read, so source ids can be copied into config. */
async function main() {
  const config = loadConfig();
  if (!config.session) {
    console.error('TG_SESSION is empty. Run `npm run login` first.');
    process.exit(1);
  }

  const client = createClient(config);
  await client.connect();

  const dialogs = await client.getDialogs({ limit: 500 });
  const rows = dialogs
    .filter((d) => d.isChannel || d.isGroup)
    .map((d) => {
      const entity = d.entity as { id?: { toString(): string }; username?: string };
      return {
        title: (d.title ?? '').slice(0, 44),
        id: entity?.id?.toString() ?? '',
        username: entity?.username ? `@${entity.username}` : '',
        kind: d.isChannel ? 'channel' : 'group',
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  console.log(`\n${rows.length} groups and channels:\n`);
  console.log('  ' + 'TITLE'.padEnd(46) + 'ID'.padEnd(16) + 'USERNAME'.padEnd(24) + 'KIND');
  console.log('  ' + '─'.repeat(96));
  for (const r of rows) {
    console.log('  ' + r.title.padEnd(46) + r.id.padEnd(16) + r.username.padEnd(24) + r.kind);
  }
  console.log('\nPaste an ID into config/sources.json as "peerId", or the username as "username".\n');

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
