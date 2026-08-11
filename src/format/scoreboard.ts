import type { Scoreboard } from '../track/stats';
import { duration, escapeHtml } from './call';

/**
 * The pinned track record.
 *
 * Every group posts its winners; the number that makes the rest believable is the worst one,
 * and it is on here on purpose. So is the denominator, so is the rug count, and so is the
 * number of calls we could not price — because a rate quoted without them is the trick
 * everybody else is running, and being the group that does not run it is the whole position.
 *
 * Nothing here is written by hand. Every figure comes from prices sampled after the call went
 * out, which is what makes it checkable against a chart by anyone who cares to.
 */
export function renderScoreboard(board: Scoreboard, now = new Date()): string | undefined {
  if (!board.called) return undefined;

  const lines = ['📊 <b>pumpgod · track record</b>', ''];
  lines.push(`<b>${board.called}</b> call${board.called === 1 ? '' : 's'}${since(board, now)}`);

  if (board.priced) {
    lines.push(
      `<b>${board.hit2x}</b> hit 2x · <b>${board.hit5x}</b> hit 5x · <b>${board.hit10x}</b> hit 10x` +
        ` <i>(of ${board.priced} priced)</i>`,
    );
    lines.push(`median peak <b>${board.medianPeak.toFixed(2)}x</b>`);
  }

  lines.push('');
  // Both tickers are escaped. A symbol is free text chosen by whoever deployed the coin, and
  // this message is pinned at the top of the channel — the one place a stranger's markup would
  // be read as ours. `tokenText` takes the brackets out on the way in; this is the second lock.
  if (board.best) {
    lines.push(`best · ${escapeHtml(board.best.ticker)} <b>${multiple(board.best.multiple)}</b>${run(board.best)}`);
  }
  // Named even when it is the same coin as the best: one call, two honest numbers.
  if (board.worst) lines.push(`worst · ${escapeHtml(board.worst.ticker)} <b>${multiple(board.worst.multiple)}</b>`);

  const caveats = [
    board.rugged ? `${board.rugged} rugged` : undefined,
    board.unpriced ? `${board.unpriced} we could not price` : undefined,
  ].filter(Boolean);
  if (caveats.length) lines.push(caveats.join(' · '));

  lines.push('', '<i>Measured automatically from the price after each call. Every one of them is above — check any.</i>');
  return lines.join('\n');
}

/**
 * The same record, as something that arrives rather than something you go and look at.
 *
 * The pinned board is where a stranger checks us; this is where an existing member is reminded
 * we are still counting. They quote the same figures from the same function on purpose — the
 * window is the only difference — because a digest computed separately from the board is two
 * numbers about the same calls, and the first person to notice the gap is the last one who
 * trusts either.
 *
 * Nothing is said on a day with no calls. A daily post reading "0 calls" is how a channel
 * teaches people to mute it, and there is no receipt to publish for a day we sat out.
 *
 * The loss goes in the same line as the win, not below it as a caveat. A digest that leads
 * with the best call and buries the worst is the format every other group already uses, and
 * the reason theirs is not believed.
 */
export function renderDigest(board: Scoreboard, hours = 24): string | undefined {
  if (!board.called) return undefined;

  const lines = [`📊 <b>Last ${hours}h</b>`, ''];
  lines.push(`<b>${board.called}</b> call${board.called === 1 ? '' : 's'}`);

  if (board.priced) {
    const hits = [
      board.hit2x ? `<b>${board.hit2x}</b> hit 2x` : undefined,
      board.hit5x ? `<b>${board.hit5x}</b> hit 5x` : undefined,
      board.hit10x ? `<b>${board.hit10x}</b> hit 10x` : undefined,
    ].filter(Boolean);
    // A window with nothing above 2x says so in words. Printing "0 hit 2x · 0 hit 5x" is
    // technically the same fact dressed up as a table, and reads as a malfunction.
    lines.push(hits.length ? hits.join(' · ') : 'nothing reached 2x');
    lines.push(`median peak <b>${board.medianPeak.toFixed(2)}x</b> <i>(of ${board.priced} priced)</i>`);
  }

  lines.push('');
  if (board.best) lines.push(`best · ${escapeHtml(board.best.ticker)} <b>${multiple(board.best.multiple)}</b>${run(board.best)}`);
  if (board.worst) lines.push(`worst · ${escapeHtml(board.worst.ticker)} <b>${multiple(board.worst.multiple)}</b>`);

  const caveats = [
    board.rugged ? `${board.rugged} rugged` : undefined,
    board.unpriced ? `${board.unpriced} we could not price` : undefined,
  ].filter(Boolean);
  if (caveats.length) lines.push(caveats.join(' · '));

  lines.push('', '<i>Every call above is still in the channel with its timestamp. Check any of them.</i>');
  return lines.join('\n');
}

/**
 * Two decimals under 10x, where the difference between 1.4x and 1.8x is the whole story.
 *
 * Exported because the agent quotes the same figures conversationally, and a multiple written
 * one way on the pinned board and another way in a reply is two numbers as far as the reader
 * is concerned — about calls they can go and check.
 */
export function multiple(value: number): string {
  return value >= 10 ? `${value.toFixed(1)}x` : `${value.toFixed(2)}x`;
}

function run(best: NonNullable<Scoreboard['best']>): string {
  // The time has to name the milestone it belongs to. "24x · 4m" reads as the peak taking
  // four minutes when 4m was only the time to 2x — a claim the chart disproves.
  return best.run ? ` · ${best.run.milestone}x in ${duration(best.run.seconds)}` : '';
}

function since(board: Scoreboard, now: Date): string {
  if (board.since === undefined) return '';
  const start = new Date(board.since);
  const sameYear = start.getFullYear() === now.getFullYear();
  const date = start.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return ` since ${date}`;
}
