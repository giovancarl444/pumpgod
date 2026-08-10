import { parseCall } from '../src/parse';

/**
 * Two very different numbers matter here.
 *
 * Parse time is what pumpgod controls: it runs inside the update handler, so it is pure
 * overhead on every call. Send round-trip is dominated by distance to Telegram's data
 * centre, which is a hosting decision, not a code one. Measuring them separately is the
 * only way to tell which one to spend effort on.
 */

const CORPUS = [
  'Soaps Gems 💎 Troll in Hood | TROLL\nCA: 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90\n📊 Market Cap: $36.27K 🌐 Robinhood Chain 💧 Liquidity: $16.91K 📈 Volume: $26.41K ⏰ Token Age: 4h',
  '🚀 $WIF looking ready\n7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  'new one https://pump.fun/coin/8xJ2p5vNqR3kLmT7wYcZaB4dEfGhJkMnPqRsTuVwXyZa',
  'gm frens, what are we looking at today',
  'this chart looks insane ngl, might be the one',
  'Contract Address: 5TokEnTokEnTokEnTokEnTokEnTokEnTokEnTokEnTok\nMC: $120K | LIQ: $45K',
  'anyone else in this? feels early',
  'Name: Dogwifhat\nTicker: WIF\nCA: 7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr\nMcap $2.1M Liquidity $340K Volume $1.2M Holders 4200',
];

function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1]! };
}

function fmt(us: number) {
  return us < 1000 ? `${us.toFixed(1)}µs` : `${(us / 1000).toFixed(2)}ms`;
}

function benchParse() {
  const ITERATIONS = 50_000;

  // Warm up so V8 has tiered the hot functions up before anything is recorded.
  for (let i = 0; i < 5_000; i++) parseCall(CORPUS[i % CORPUS.length]!);

  const samples: number[] = [];
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const text = CORPUS[i % CORPUS.length]!;
    const t0 = performance.now();
    parseCall(text);
    samples.push((performance.now() - t0) * 1000);
  }
  const wall = performance.now() - start;

  const p = percentiles(samples);
  console.log('\n  parse (mixed corpus, per message)');
  console.log(`    p50 ${fmt(p.p50)}   p95 ${fmt(p.p95)}   p99 ${fmt(p.p99)}   max ${fmt(p.max)}`);
  console.log(`    throughput ~${Math.round(ITERATIONS / (wall / 1000)).toLocaleString()} msg/sec\n`);

  const calls = CORPUS.filter((c) => parseCall(c) !== null).length;
  console.log(`  corpus: ${calls}/${CORPUS.length} recognised as calls`);

  const rejects = CORPUS.filter((c) => parseCall(c) === null);
  const rejectSamples: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const text = rejects[i % rejects.length]!;
    const t0 = performance.now();
    parseCall(text);
    rejectSamples.push((performance.now() - t0) * 1000);
  }
  const rp = percentiles(rejectSamples);
  console.log(`\n  reject path (ordinary chatter, the common case)`);
  console.log(`    p50 ${fmt(rp.p50)}   p95 ${fmt(rp.p95)}   p99 ${fmt(rp.p99)}\n`);
}

async function benchNetwork() {
  const { loadConfig } = await import('../src/config');
  const { createClient, resolveInputPeer } = await import('../src/telegram/client');
  const { sendFast } = await import('../src/telegram/send');

  const config = loadConfig();
  if (!config.session || !config.warRoom) {
    console.log('  network: skipped (needs TG_SESSION and WAR_ROOM_CHAT in .env)\n');
    return;
  }

  const client = createClient(config);
  await client.connect();
  const peer = await resolveInputPeer(client, config.warRoom);

  const ROUNDS = 10;
  const samples: number[] = [];
  console.log(`  network: sending ${ROUNDS} probes to the war room...`);
  for (let i = 0; i < ROUNDS; i++) {
    const r = await sendFast(client, peer, `<i>pumpgod latency probe ${i + 1}/${ROUNDS}</i>`, {
      stage: 'bench',
      silent: true,
    });
    samples.push(r.ackAt - r.dispatchAt);
    await new Promise((res) => setTimeout(res, 400));
  }

  const p = percentiles(samples);
  console.log('\n  send round-trip (dispatch → Telegram ack)');
  console.log(
    `    p50 ${p.p50.toFixed(1)}ms   p95 ${p.p95.toFixed(1)}ms   p99 ${p.p99.toFixed(1)}ms   max ${p.max.toFixed(1)}ms\n`,
  );
  console.log('  If p50 is above ~120ms, the win is hosting closer to Telegram, not code.\n');

  await client.disconnect();
}

async function main() {
  console.log('\n─── pumpgod benchmark ───');
  benchParse();
  if (process.argv.includes('--network')) await benchNetwork();
  else console.log('  network: skipped (pass --network to measure send round-trip)\n');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
