import { loadShadowChains, loadWatchlist } from '../src/config';
import { shadowPass, type HandleResult } from '../src/pipeline/shadow';
import { Watched } from '../src/store/watched';
import { Tracker } from '../src/track/tracker';

/**
 * Reads every channel on the watchlist and records what they called.
 *
 * Deliberately a script rather than part of the daemon. The bot holds the token that owns our
 * channel; this holds nothing and talks to nobody but `t.me` and two public price APIs. Keeping
 * them in separate processes means a change here can never restart the bot, and a crash here
 * cannot take the channel down — which matters most in the first weeks, when this is the file
 * being edited and the bot is the thing that must not stop.
 *
 *   npm run shadow            one pass, then exit
 *   npm run shadow -- --loop  keep going, one pass every 10 minutes
 *
 * The measurement it produces is the input to `npm run scorecard`, and the scorecard is what
 * decides which groups are ever worth copying. Until roughly twenty priced calls per source
 * exist, it will say so rather than rank anybody.
 */

/**
 * Ten minutes.
 *
 * Nothing here needs to be quick — times come off Telegram's own timestamps and prices off the
 * chart at that minute, so a call found ten minutes late scores identically to one found live.
 * What the interval does buy is a defence against the one thing that cannot be recovered: a
 * group deleting a losing call before anyone saw it. Twenty posts per page at ten minutes
 * covers every channel on the list many times over.
 */
const LOOP_MS = 10 * 60 * 1000;

function line(r: HandleResult): string {
  const skips = Object.entries(r.skipped)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${n} ${why}`)
    .join(', ');
  const noted = r.recorded ? `+${r.recorded}` : ' ·';
  return `  ${noted}  @${r.handle.padEnd(24)} ${String(r.fresh).padStart(3)} new${skips ? `   (${skips})` : ''}`;
}

async function pass(handles: string[], tracker: Tracker, seen: Watched): Promise<void> {
  const started = Date.now();

  // Not `config.chains`. That setting is about what we are willing to publish; this is about
  // what we are willing to measure, and nothing recorded here can be published. See
  // `loadShadowChains`.
  const results = await shadowPass({ handles, tracker, seen, chains: loadShadowChains() });

  const recorded = results.reduce((n, r) => n + r.recorded, 0);
  const fresh = results.reduce((n, r) => n + r.fresh, 0);
  const reasons = new Map<string, number>();
  for (const r of results) {
    for (const [why, n] of Object.entries(r.skipped)) reasons.set(why, (reasons.get(why) ?? 0) + n);
  }

  for (const r of results) if (r.recorded || r.fresh) console.log(line(r));

  // Recording a call is only half of measuring one. Nothing else prices these: the daemon holds
  // its own calls in memory and never loads the ones written here, so without this a scraped row
  // keeps its entry price forever and the scorecard has nothing to rank. See `settleAged`.
  const settled = await tracker.settleAged();

  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(
    `\n  ${recorded} call(s) recorded from ${fresh} new post(s) across ${handles.length} channels in ${secs}s`,
  );
  if (settled) console.log(`  ${settled} call(s) past 24h priced against the chart`);
  if (reasons.size) {
    console.log(
      `  passed over: ${[...reasons].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ')}`,
    );
  }

  // The one number that says whether the filter is still working. If everything with an address
  // in it is suddenly reading as a recap, or nothing has an address at all, that is a markup
  // change at Telegram's end and not a quiet week — and it looks identical to one from here.
  const dark = seen.list().filter((m) => m.misses >= 3);
  if (dark.length) {
    console.log(`  ⚠️  no readable page from: ${dark.map((m) => `@${m.handle}`).join(', ')}`);
  }
  console.log(`\n  ${tracker.size} tracked overall · npm run scorecard to rank them\n`);
}

async function main(): Promise<void> {
  const handles = loadWatchlist();
  if (!handles.length) {
    console.error(
      '\n  No config/watchlist.json. Copy config/watchlist.example.json and list the public\n' +
        '  @handles to measure — nothing is joined and no account is used, so any channel with\n' +
        '  its web preview left on can go on it.\n',
    );
    process.exit(1);
  }

  const tracker = new Tracker();
  tracker.load();
  const seen = new Watched();
  seen.load();

  console.log(`\n─── shadow pass ─── ${handles.length} channels, recording nothing publishable\n`);
  await pass(handles, tracker, seen);

  if (!process.argv.includes('--loop')) return;

  console.log(`  looping every ${LOOP_MS / 60000} minutes — ctrl-c to stop\n`);

  // A pass spends most of its time waiting out the candle API's rate limit, so it can run for
  // minutes. If one overran the interval, `setInterval` would start a second alongside it and
  // the two would race the same stores and burn the same quota twice, making each other slower
  // and the overlap permanent.
  let running = false;
  setInterval(() => {
    if (running) {
      console.log('  previous pass still running — skipping this tick');
      return;
    }
    running = true;
    void pass(handles, tracker, seen)
      .catch((err: Error) => console.error(`  pass failed: ${err.message}`))
      .finally(() => {
        running = false;
      });
  }, LOOP_MS);
}

void main();
