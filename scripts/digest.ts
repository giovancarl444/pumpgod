import { renderDigest } from '../src/format/scoreboard';
import { isPublished, scoreboard } from '../src/track/stats';
import { Tracker } from '../src/track/tracker';

/**
 * Prints the daily digest without posting it, and without consulting the broadcast clock.
 *
 * The point is to be able to read the thing before ever letting it speak. `AGENT_BROADCAST`
 * turns on a message that goes out unattended once a day, and nobody should be switching that
 * on having only read the code that renders it.
 *
 * Deliberately no transport is constructed here at all — not a disabled one, not a dry-run one.
 * A preview script that holds a live channel handle is one bad edit from being a publish script.
 */

const HOURS = Number(process.argv[2] ?? 24);

function main(): void {
  const tracker = new Tracker();
  tracker.load();

  const at = Date.now();
  const windowMs = HOURS * 3_600_000;
  const all = tracker.list();
  const window = all.filter((c) => isPublished(c) && at - c.calledAt <= windowMs);

  console.log(`${all.length} tracked · ${all.filter(isPublished).length} published · ${window.length} in the last ${HOURS}h\n`);

  const text = renderDigest(scoreboard(window), HOURS);
  if (!text) {
    console.log(`Nothing would be posted — no published calls in the last ${HOURS}h.`);
    console.log('That is the intended behaviour on a quiet day, not a failure.');
    return;
  }

  console.log('─'.repeat(56));
  console.log(text);
  console.log('─'.repeat(56));
  console.log('\nThis is exactly what would go out, once every 24h, silently.');
}

main();
