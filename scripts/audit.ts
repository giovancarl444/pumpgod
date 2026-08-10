import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../src/config';
import { peakSince, priceAt } from '../src/pipeline/history';
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

interface Finding {
  call: TrackedCall;
  what: string;
  was: number | undefined;
  now: number;
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
    found.push({ call, what: 'entry', was: call.entryPriceUsd, now: entry });
  }

  const peak = await peakSince(call.chain, call.poolAddress, call.calledAt, undefined, call.address);
  if (peak) {
    const sampled = call.athPriceUsd ?? 0;
    // Same rule the tracker settles by: the chart may raise a peak freely, and may lower one
    // only when the sample is further above it than two live pools of a coin can be.
    const contradicted = sampled > peak.priceUsd * CONTRADICTED;
    if (contradicted || peak.priceUsd > sampled * (1 + TOLERANCE)) {
      found.push({
        call,
        what: contradicted ? 'peak (fiction)' : 'peak',
        was: call.athPriceUsd,
        now: peak.priceUsd,
        at: peak.at,
      });
    }
  }

  return found;
}

function apply(finding: Finding): void {
  const { call, now } = finding;

  if (finding.what === 'entry') {
    // The market cap moves with it. Supply is fixed, so scaling the one we have keeps the two
    // consistent — where re-reading a cap separately would eventually contradict the price.
    if (call.entryMcUsd && call.entryPriceUsd) call.entryMcUsd = (call.entryMcUsd * now) / call.entryPriceUsd;
    call.entryPriceUsd = now;
    call.entryFromChart = true;
    // The peak was a multiple of the old entry. Leaving it would publish a run that never
    // happened, so it is dropped and re-read below on the same pass.
    call.athPriceUsd = undefined;
    call.athMcUsd = undefined;
    call.athAt = undefined;
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
  for (const call of priced) {
    const found = await inspect(call);
    for (const f of found) {
      findings.push(f);
      const label = f.call.ticker ? `$${f.call.ticker}` : f.call.address.slice(0, 10);
      const flag = f.what.includes('fiction') ? '  ✗' : '  ~';
      console.log(
        `${flag} ${label.padEnd(14)} ${f.what.padEnd(15)} recorded ${price(f.was).padEnd(12)} chart ${price(f.now)}   ${f.call.sourceId}`,
      );
    }
  }

  if (!findings.length) {
    console.log('  every recorded number matches the chart\n');
    return;
  }

  const fictions = findings.filter((f) => f.what.includes('fiction')).length;
  console.log(`\n  ${findings.length} disagreement(s)${fictions ? `, ${fictions} of them a number that was never true` : ''}`);

  if (!fix) {
    console.log('  nothing written — re-run with --fix to adopt the chart\n');
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

void main();
