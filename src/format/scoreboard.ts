import type { Scoreboard } from '../track/stats';
import { duration } from './call';

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
  if (board.best) lines.push(`best · ${board.best.ticker} <b>${multiple(board.best.multiple)}</b>${run(board.best)}`);
  // Named even when it is the same coin as the best: one call, two honest numbers.
  if (board.worst) lines.push(`worst · ${board.worst.ticker} <b>${multiple(board.worst.multiple)}</b>`);

  const caveats = [
    board.rugged ? `${board.rugged} rugged` : undefined,
    board.unpriced ? `${board.unpriced} we could not price` : undefined,
  ].filter(Boolean);
  if (caveats.length) lines.push(caveats.join(' · '));

  lines.push('', '<i>Measured automatically from the price after each call. Every one of them is above — check any.</i>');
  return lines.join('\n');
}

/** Two decimals under 10x, where the difference between 1.4x and 1.8x is the whole story. */
function multiple(value: number): string {
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
