import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCall } from '../src/parse';
import { ROOT } from '../src/config';

/**
 * Replays journalled messages through the current parser. Parser changes are the easiest
 * thing to regress, and a real corpus catches what handwritten fixtures do not — run this
 * before shipping any change to src/parse.
 */
function main() {
  const dir = resolve(ROOT, 'data');
  if (!existsSync(dir)) {
    console.error('No data/ directory yet — run the bot for a while to collect a corpus.');
    process.exit(1);
  }

  const files = readdirSync(dir).filter((f) => f.startsWith('journal-') && f.endsWith('.jsonl'));
  if (!files.length) {
    console.error('No journal files found in data/.');
    process.exit(1);
  }

  let total = 0;
  let parsed = 0;
  const byChain = new Map<string, number>();
  const byOrigin = new Map<string, number>();
  const misses: string[] = [];

  for (const file of files) {
    for (const line of readFileSync(resolve(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let entry: { kind?: string; rawText?: string; address?: string };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!entry.rawText) continue;

      total++;
      const call = parseCall(entry.rawText);
      if (!call) {
        if (entry.address) misses.push(entry.rawText.slice(0, 120));
        continue;
      }
      parsed++;
      byChain.set(call.token.chain, (byChain.get(call.token.chain) ?? 0) + 1);
      byOrigin.set(call.token.origin, (byOrigin.get(call.token.origin) ?? 0) + 1);
    }
  }

  console.log(`\n  replayed ${total} journalled messages from ${files.length} file(s)`);
  console.log(`  parsed as calls: ${parsed} (${total ? ((parsed / total) * 100).toFixed(1) : '0'}%)\n`);

  if (byChain.size) {
    console.log('  by chain:');
    for (const [chain, n] of [...byChain].sort((a, b) => b[1] - a[1])) console.log(`    ${chain.padEnd(14)} ${n}`);
  }
  if (byOrigin.size) {
    console.log('\n  by address origin:');
    for (const [origin, n] of [...byOrigin].sort((a, b) => b[1] - a[1])) console.log(`    ${origin.padEnd(14)} ${n}`);
  }
  if (misses.length) {
    console.log(`\n  ⚠️  ${misses.length} previously-detected messages no longer parse — a regression:`);
    for (const m of misses.slice(0, 10)) console.log(`    ${m}`);
  }
  console.log('');
}

main();
