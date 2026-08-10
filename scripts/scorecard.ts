import { Tracker } from '../src/track/tracker';
import { byCaller, rank, type CallerRecord } from '../src/track/stats';
import { duration, money } from '../src/format/call';

/**
 * Ranks sources on what their calls actually did, not on how loud they are.
 *
 * Peak multiple is reported as a median rather than a mean on purpose: one 200x drags a
 * mean somewhere useless, and the question being answered is "what does a typical call from
 * this group do", not "what is the best thing that ever happened".
 *
 * Every figure comes from `byCaller`, which is also what the member leaderboard is built from
 * and what the pinned board's rules are written in. There is one definition of "how did this
 * caller do" in the codebase, and this is a view of it rather than a second opinion.
 */

/** Below this many priced calls, a median is noise dressed up as a number. */
const MIN_SAMPLE = 20;

/** A column with nothing in it says so, rather than printing a confident zero. */
function or(value: string | undefined): string {
  return value ?? '—';
}

function pct(n: number, of: number): string {
  return of ? `${((n / of) * 100).toFixed(0)}%` : '—';
}

function main() {
  const all = Tracker.read();
  if (!all.length) {
    console.error('\n  Nothing tracked yet. Run the bot for a while — shadow sources count too.\n');
    process.exit(1);
  }

  const onlyCalled = process.argv.includes('--called');
  const calls = onlyCalled ? all.filter((c) => c.outcome === 'called') : all;

  const rows = rank(byCaller(calls), MIN_SAMPLE);

  console.log(`\n─── source scorecard ─── ${calls.length} calls${onlyCalled ? ' (published only)' : ''}\n`);
  console.log(
    '  ' +
      'SOURCE'.padEnd(18) +
      'N'.padEnd(6) +
      'PRICED'.padEnd(8) +
      'MED PEAK'.padEnd(11) +
      '2x'.padEnd(8) +
      '5x'.padEnd(8) +
      '10x'.padEnd(8) +
      'RUG'.padEnd(8) +
      'MED ENTRY'.padEnd(12) +
      'MED→2x',
  );
  console.log('  ' + '─'.repeat(102));

  for (const r of rows) {
    console.log(
      '  ' +
        r.id.padEnd(18) +
        String(r.picks).padEnd(6) +
        String(r.priced).padEnd(8) +
        `${r.medianPeak.toFixed(2)}x`.padEnd(11) +
        // Against what we could price, not against everything submitted: a call with no price
        // is not a miss, and counting it as one makes every group look worse than it was.
        pct(r.hit2x, r.priced).padEnd(8) +
        pct(r.hit5x, r.priced).padEnd(8) +
        pct(r.hit10x, r.priced).padEnd(8) +
        pct(r.rugged, r.picks).padEnd(8) +
        or(r.medianEntryMcUsd ? money(r.medianEntryMcUsd) : undefined).padEnd(12) +
        or(r.medianTimeTo2xSec === undefined ? undefined : duration(r.medianTimeTo2xSec)),
    );
  }

  const unpriced = rows.reduce((sum: number, r: CallerRecord) => sum + r.unpriced, 0);
  if (unpriced) {
    console.log(`\n  ${unpriced} call(s) never got a price and are excluded from every rate above.`);
  }

  const thin = rows.filter((r) => r.priced < MIN_SAMPLE);
  if (thin.length) {
    console.log(
      `\n  ⚠️  ${thin.map((r) => r.id).join(', ')} — under ${MIN_SAMPLE} priced calls. ` +
        'Too few to promote out of shadow yet.',
    );
  }

  const best = rows.find((r) => r.priced >= MIN_SAMPLE);
  if (best) {
    console.log(
      `\n  Best on current data: ${best.id} — median ${best.medianPeak.toFixed(2)}x, ` +
        `${pct(best.hit2x, best.priced)} hit 2x, ${pct(best.rugged, best.picks)} rugged.`,
    );
  }

  console.log('\n  --called restricts this to calls actually published.\n');
}

main();
