import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config';
import { peakSince, priceAt } from '../src/pipeline/history';
import { isPublished } from '../src/track/stats';
import { CONTRADICTED, type TrackedCall } from '../src/track/tracker';

/**
 * Reads every recorded number back off the chart and reports where the record disagrees.
 *
 *   npm run audit          say what disagrees, change nothing
 *   npm run audit -- --fix adopt the chart's answer where it is the better one
 *
 * This is the claim the whole product rests on, executed against ourselves. "Check our numbers
 * against the chart" is only worth saying if we run the check first, and it is the one form of
 * verification that does not depend on our own code being right — the candles come from
 * somewhere else and were written by trades, not by us.
 *
 * It exists because of what this project keeps hitting. Four separate bugs so far have shared a
 * single signature: everything reported success and returned a plausible number. A rate limit, a
 * missing chain slug, an address that is a different coin on another chain, a pool quoted from
 * the wrong side — none of them raised anything, and each was found by a person happening to
 * look at a figure and thinking it seemed large. That is not a control. This is.
 *
 * The tracker now refuses to believe a sample the chart contradicts, but that guard only runs
 * when a call retires, and it cannot help a row written before it existed: a peak only ever
 * climbed, so a fiction recorded once outlived the bug that produced it. Hence `--fix`, and
 * hence the dry run being the default — a tool that rewrites a track record should have to be
 * asked twice.
 *
 * **Stop the daemon first.** Both it and this write `data/tracked.json`, and the daemon holds
 * every row it has loaded in memory. `merged()` keeps the higher peak of the two copies at save
 * time, precisely so a peak survives a crash — which means a repair written underneath a running
 * daemon is reverted by it within the minute, silently, and the audit would appear to have done
 * nothing at all.
 */

const STORE = resolve(ROOT, 'data/tracked.json');

/** Below this the two agree in every sense that matters; chart precision is not the subject. */
const TOLERANCE = 0.02;

/**
 * How far apart the two readings must be before a person is shown the row.
 *
 * Adopting the chart and reporting the disagreement are different questions, and conflating
 * them makes this useless. A call still inside its 24h window has a peak that is the best of
 * however many samples we managed to take, so the chart is *routinely* a little above it —
 * that gap is the ordinary work of the tool, not news. Printing all of it buries the one line
 * that says a recorded number was never true, and a report nobody can read is a report nobody
 * reads. Everything below the line is still fixed; it is counted rather than narrated.
 */
const NOTABLE = 1.25;

/**
 * Longer than the daemon's poll, so a live writer is always caught rather than caught usually.
 * A shadow pass saves per channel and is slower, but it also runs for minutes at a stretch, so
 * the same window sees it.
 */
const WRITER_IDLE_SEC = 90;

export interface Finding {
  call: TrackedCall;
  what: 'entry' | 'peak';
  was: number | undefined;
  now: number;
  /** A number that was never true, as against one the chart simply knows better. */
  fiction?: boolean;
  /** When the chart says the peak landed. Absent for an entry, which is fixed at call time. */
  at?: number;
}

function ratio(a: number, b: number): number {
  return a > b ? a / b : b / a;
}

function price(n: number | undefined): string {
  if (n === undefined) return '—';
  return n < 0.01 ? n.toPrecision(3) : `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

async function inspect(call: TrackedCall): Promise<Finding[]> {
  const found: Finding[] = [];
  if (!call.poolAddress) return found;

  const entry = await priceAt(call.chain, call.poolAddress, call.calledAt, undefined, call.address);

  /**
   * An entry is only ever improved by the chart, never argued with.
   *
   * Two things can be recorded here. A price read off the candle at the minute of the call,
   * which is the number we want and is already right; or the price we happened to see when we
   * looked, which for a scraped call is however long we took to find the post. The second is
   * wrong in both directions — a coin that dumped in between flatters the group, one that ran
   * buries it — so replacing it with the candle is strictly a repair.
   *
   * A coin too new to have candles when it was scraped grows them later, so this also finishes
   * the rows that could not be priced at the time rather than leaving them permanently marked.
   */
  if (entry !== undefined && (!call.entryFromChart || ratio(entry, call.entryPriceUsd ?? 0) > 1 + TOLERANCE)) {
    // An entry cannot be undersampled the way a peak can — it is one price at one minute, and
    // both sides claim to be that same price. So any real gap here is one of them being wrong.
    const gap = ratio(entry, call.entryPriceUsd ?? 0);
    found.push({ call, what: 'entry', was: call.entryPriceUsd, now: entry, fiction: gap > CONTRADICTED });
  }

  const peak = await peakSince(call.chain, call.poolAddress, call.calledAt, undefined, call.address);
  if (peak) {
    const sampled = call.athPriceUsd ?? 0;
    // Same rule the tracker settles by: the chart may raise a peak freely, and may lower one
    // only when the sample is further above it than two live pools of a coin can be.
    const contradicted = sampled > peak.priceUsd * CONTRADICTED;
    if (contradicted || peak.priceUsd > sampled * (1 + TOLERANCE)) {
      found.push({ call, what: 'peak', was: call.athPriceUsd, now: peak.priceUsd, at: peak.at, fiction: contradicted });
    }
  }

  return found;
}

/**
 * Adopts one reading, and carries everything derived from it along.
 *
 * The distinction that matters here is which figures are observations and which are arithmetic.
 * Both prices are observations. Both market caps are not — they are scaled from a price, because
 * supply is fixed for anything in this market and one number derived from another cannot come to
 * contradict it. So correcting a price silently invalidates every cap standing on it, and a
 * repair that fixed the price alone would leave a row internally at war with itself: SPX6900's
 * entry was $772.97 against a real $0.000119, which is also where its $773bn market cap came
 * from.
 */
export function apply(finding: Finding): void {
  const { call, now } = finding;

  if (finding.what === 'entry') {
    /**
     * A published entry is a claim, not a record, and it is not this script's to revise.
     *
     * For a scraped call the chart is simply better evidence than the price we happened to see,
     * so adopting it is a repair. For one of ours the number went out on a card that people
     * read and acted on; quietly aligning the database to the chart afterwards would leave our
     * stored history disagreeing with our own published history, and "we edited the entry
     * later" is indistinguishable from the thing we exist not to be. If a published entry is
     * genuinely wrong, that is a person deciding what to say about it, not a script deciding
     * for them — so it is still reported, and still not touched.
     */
    if (isPublished(call)) return;

    const old = call.entryPriceUsd;
    if (call.entryMcUsd && old) call.entryMcUsd = (call.entryMcUsd * now) / old;
    call.entryPriceUsd = now;
    call.entryFromChart = true;
    // The peak's own market cap was scaled off the entry we just moved, so it moves too. Its
    // *price* is an observation in its own right and is not ours to discard on this evidence.
    if (call.entryMcUsd && call.athPriceUsd) call.athMcUsd = (call.entryMcUsd * call.athPriceUsd) / now;
    return;
  }

  if (call.entryMcUsd && call.entryPriceUsd) call.athMcUsd = (call.entryMcUsd * now) / call.entryPriceUsd;
  call.athPriceUsd = now;
  call.athAt = finding.at;
  call.athFromChart = true;
}

async function main(): Promise<void> {
  const fix = process.argv.includes('--fix');

  if (!existsSync(STORE)) {
    console.error('\n  No data/tracked.json yet — nothing has been recorded.\n');
    process.exit(1);
  }

  const calls = JSON.parse(readFileSync(STORE, 'utf8')) as TrackedCall[];
  const priced = calls.filter((c) => c.poolAddress);

  console.log(`\n─── audit ─── ${priced.length} of ${calls.length} rows have a pool to read back\n`);
  // Two requests a row against a rate limit the client paces itself under. Said out loud
  // because a silent five-minute wait looks exactly like a hang.
  console.log(`  reading ${priced.length * 2} charts, roughly ${Math.ceil((priced.length * 2 * 2.2) / 60)} min\n`);

  const findings: Finding[] = [];
  let quiet = 0;
  for (const call of priced) {
    const found = await inspect(call);
    for (const f of found) {
      findings.push(f);
      const gap = ratio(f.now, f.was ?? 0);
      if (!f.fiction && gap < NOTABLE) {
        quiet++;
        continue;
      }
      const label = f.call.ticker ? `$${f.call.ticker}` : f.call.address.slice(0, 10);
      console.log(
        `${f.fiction ? '  ✗' : '  ~'} ${label.padEnd(14)} ${f.what.padEnd(6)} ` +
          `recorded ${price(f.was).padEnd(13)} chart ${price(f.now).padEnd(13)} ` +
          `${Number.isFinite(gap) ? `${gap.toFixed(gap > 100 ? 0 : 1)}x` : 'new'}   ${f.call.sourceId}`,
      );
    }
  }

  if (!findings.length) {
    console.log('  every recorded number matches the chart\n');
    return;
  }

  const fictions = findings.filter((f) => f.fiction).length;
  console.log(
    `\n  ${findings.length} disagreement(s)` +
      (quiet ? `, ${quiet} of them within the ordinary gap between a sampled peak and a charted one` : '') +
      (fictions ? `\n  ${fictions} number(s) that were never true — these are the ones that matter` : ''),
  );

  if (!fix) {
    console.log('  nothing written — re-run with --fix to adopt the chart\n');
    return;
  }

  /**
   * A repair written underneath a live writer is not a repair.
   *
   * The daemon and the shadow loop both hold every row they have loaded in memory and write the
   * file whole. `merged()` keeps the higher peak of the two copies at save time — deliberately,
   * so a peak survives a crash — which means a correction that *lowers* a number is reverted
   * within the minute, and an entry is reverted whenever the other process checked more
   * recently. Some of the fix would land, some would vanish, and the output would say it all
   * worked. That is the exact failure this whole file exists to catch, so it is not one this
   * file is allowed to have.
   *
   * mtime is the signal, because a polling process rewrites the file every cycle whether or not
   * anything changed about the coin.
   */
  const idleSec = (Date.now() - statSync(STORE).mtimeMs) / 1000;
  if (idleSec < WRITER_IDLE_SEC && !process.argv.includes('--force')) {
    console.log(
      `\n  ✗ not writing — something else wrote data/tracked.json ${idleSec.toFixed(0)}s ago.\n\n` +
        '    Stop the daemon (npm run dev) and any shadow loop first, then re-run. Both keep\n' +
        '    the rows they hold in memory, so a repair made underneath them is partly reverted\n' +
        '    and partly kept, with nothing to show which was which.\n\n' +
        '    --force writes anyway, if you know the other writer holds none of these rows.\n',
    );
    process.exitCode = 1;
    return;
  }

  // Re-read rather than reusing the array we walked: a pass takes minutes, and the shadow
  // scraper may have added rows in that time. Findings are re-matched by identity so an
  // untouched row is written back exactly as it was found.
  const current = JSON.parse(readFileSync(STORE, 'utf8')) as TrackedCall[];
  const byKey = new Map(current.map((c) => [`${c.sourceId}|${c.chain}|${c.address}`, c]));
  let changed = 0;
  for (const f of findings) {
    const row = byKey.get(`${f.call.sourceId}|${f.call.chain}|${f.call.address}`);
    if (!row) continue;
    apply({ ...f, call: row });
    changed++;
  }

  writeFileSync(STORE, JSON.stringify(current, null, 2));
  console.log(`  ${changed} row(s) rewritten from the chart\n`);
}

if (require.main === module) void main();
