import { Tracker, type TrackedCall } from '../src/track/tracker';

/**
 * Ranks sources on what their calls actually did, not on how loud they are.
 *
 * Peak multiple is reported as a median rather than a mean on purpose: one 200x drags a
 * mean somewhere useless, and the question being answered is "what does a typical call from
 * this group do", not "what is the best thing that ever happened".
 */

/** Below this many calls, a median is noise dressed up as a number. */
const MIN_SAMPLE = 20;

interface Row {
  source: string;
  n: number;
  medianPeak: number;
  hit2x: number;
  hit5x: number;
  hit10x: number;
  rugged: number;
  medianEntryMc: number;
  medianTimeTo2x?: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function peak(call: TrackedCall): number | undefined {
  if (!call.entryPriceUsd || !call.athPriceUsd) return undefined;
  return call.athPriceUsd / call.entryPriceUsd;
}

function summarise(source: string, calls: TrackedCall[]): Row {
  const peaks = calls.map(peak).filter((v): v is number => v !== undefined);
  const times = calls.map((c) => c.timeTo2xSec).filter((v): v is number => v !== undefined);
  const pct = (n: number) => (calls.length ? (n / calls.length) * 100 : 0);

  return {
    source,
    n: calls.length,
    medianPeak: median(peaks),
    hit2x: pct(calls.filter((c) => c.timeTo2xSec !== undefined).length),
    hit5x: pct(calls.filter((c) => c.timeTo5xSec !== undefined).length),
    hit10x: pct(calls.filter((c) => c.timeTo10xSec !== undefined).length),
    rugged: pct(calls.filter((c) => c.rugged).length),
    medianEntryMc: median(calls.map((c) => c.entryMcUsd ?? 0).filter(Boolean)),
    medianTimeTo2x: times.length ? median(times) : undefined,
  };
}

function money(n: number): string {
  if (!n) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function duration(sec?: number): string {
  if (sec === undefined) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

function main() {
  const all = Tracker.read();
  if (!all.length) {
    console.error('\n  Nothing tracked yet. Run the bot for a while — shadow sources count too.\n');
    process.exit(1);
  }

  const onlyCalled = process.argv.includes('--called');
  const calls = onlyCalled ? all.filter((c) => c.outcome === 'called') : all;

  const bySource = new Map<string, TrackedCall[]>();
  for (const c of calls) {
    const list = bySource.get(c.sourceId) ?? [];
    list.push(c);
    bySource.set(c.sourceId, list);
  }

  // Ranking is read off the table order, so a source with three lucky calls must not sit
  // at the top. Under-sampled sources sort to the bottom however good they look.
  const rows = [...bySource.entries()]
    .map(([source, list]) => summarise(source, list))
    .sort((a, b) => {
      const aThin = a.n < MIN_SAMPLE;
      const bThin = b.n < MIN_SAMPLE;
      if (aThin !== bThin) return aThin ? 1 : -1;
      return b.medianPeak - a.medianPeak;
    });

  console.log(`\n─── source scorecard ─── ${calls.length} calls${onlyCalled ? ' (published only)' : ''}\n`);
  console.log(
    '  ' +
      'SOURCE'.padEnd(18) +
      'N'.padEnd(6) +
      'MED PEAK'.padEnd(11) +
      '2x'.padEnd(8) +
      '5x'.padEnd(8) +
      '10x'.padEnd(8) +
      'RUG'.padEnd(8) +
      'MED ENTRY'.padEnd(12) +
      'MED→2x',
  );
  console.log('  ' + '─'.repeat(94));

  for (const r of rows) {
    console.log(
      '  ' +
        r.source.padEnd(18) +
        String(r.n).padEnd(6) +
        `${r.medianPeak.toFixed(2)}x`.padEnd(11) +
        `${r.hit2x.toFixed(0)}%`.padEnd(8) +
        `${r.hit5x.toFixed(0)}%`.padEnd(8) +
        `${r.hit10x.toFixed(0)}%`.padEnd(8) +
        `${r.rugged.toFixed(0)}%`.padEnd(8) +
        money(r.medianEntryMc).padEnd(12) +
        duration(r.medianTimeTo2x),
    );
  }

  const thin = rows.filter((r) => r.n < MIN_SAMPLE);
  if (thin.length) {
    console.log(
      `\n  ⚠️  ${thin.map((r) => r.source).join(', ')} — under ${MIN_SAMPLE} calls. Too few to promote out of shadow yet.`,
    );
  }

  const best = rows.filter((r) => r.n >= MIN_SAMPLE)[0];
  if (best) {
    console.log(
      `\n  Best on current data: ${best.source} — median ${best.medianPeak.toFixed(2)}x, ` +
        `${best.hit2x.toFixed(0)}% hit 2x, ${best.rugged.toFixed(0)}% rugged.`,
    );
  }

  console.log('\n  --called restricts this to calls actually published.\n');
}

main();
