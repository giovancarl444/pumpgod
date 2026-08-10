import type { CompetitionConfig } from '../config';
import type { Standing } from '../pipeline/member';
import { escapeHtml } from './call';

/** Position markers. Past third, the number is the whole point. */
const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * The member leaderboard.
 *
 * Ranked on **median peak**, not on best pick. A table topped by whoever got luckiest once is a
 * table that never changes again, and everyone below the winner correctly stops trying. The
 * median asks the only question worth asking of a caller — what does a typical pick of theirs
 * do — and it is the same question, computed the same way, as the pinned board asks of us.
 *
 * Nobody is ranked before `minSample` priced picks. They are still listed, so a new member can
 * see their picks are being counted; they simply cannot win on three of them.
 */
export function renderLeaderboard(standings: Standing[], comp: CompetitionConfig, now = new Date()): string {
  if (!standings.length) {
    return [
      '🏆 <b>call competition</b>',
      '',
      'Nobody has entered yet. DM the bot <code>/submit &lt;contract address&gt;</code> ' +
        `— ${picksPerDay(comp)}, priced for 24 hours, scored on the peak.`,
    ].join('\n');
  }

  const ranked = standings.filter((s) => s.priced >= comp.minSample).slice(0, comp.size);
  const qualifying = standings.filter((s) => s.priced < comp.minSample);

  const lines = ['🏆 <b>call competition</b>', ''];

  if (ranked.length) {
    ranked.forEach((s, i) => {
      lines.push(`${MEDALS[i] ?? `${i + 1}.`} ${name(s)} — <b>${multiple(s.medianPeak)}</b> median${detail(s)}`);
    });
  } else {
    lines.push(`<i>No one has ${comp.minSample} priced picks yet, so nobody is ranked.</i>`);
  }

  if (qualifying.length) {
    lines.push('');
    lines.push(
      `<i>still qualifying (${comp.minSample} priced picks needed): ` +
        `${qualifying.slice(0, comp.size).map((s) => `${name(s)} ${s.priced}/${comp.minSample}`).join(' · ')}</i>`,
    );
  }

  lines.push('');
  lines.push(
    `<i>Median peak over every pick, wins and losses. ${cap(picksPerDay(comp))}. ` +
      `Picks are never posted in the channel. Updated ${time(now)}.</i>`,
  );
  return lines.join('\n');
}

/**
 * One member's own record, for `/me`.
 *
 * Shows the worst pick as well as the best, for the same reason the pinned board does: a
 * competition where the scoreboard flatters everybody is one nobody believes they are winning.
 */
export function renderStanding(standing: Standing | undefined, comp: CompetitionConfig, position?: number): string {
  if (!standing || !standing.picks) {
    return [
      '📈 <b>your record</b>',
      '',
      'No picks yet. <code>/submit &lt;contract address&gt;</code> to enter one.',
      `${cap(picksPerDay(comp))}, priced for 24 hours, scored on the peak.`,
    ].join('\n');
  }

  const lines = ['📈 <b>your record</b>', ''];
  lines.push(
    `<b>${standing.picks}</b> pick${standing.picks === 1 ? '' : 's'}` +
      (standing.priced ? ` · ${standing.priced} priced` : '') +
      (standing.unpriced ? ` · ${standing.unpriced} we could not price` : ''),
  );

  if (standing.priced) {
    lines.push(`median peak <b>${multiple(standing.medianPeak)}</b>`);
    lines.push(`<b>${standing.hit2x}</b> hit 2x · <b>${standing.hit5x}</b> hit 5x · <b>${standing.hit10x}</b> hit 10x`);
    lines.push('');
    if (standing.best) lines.push(`best · ${escapeHtml(standing.best.ticker)} <b>${multiple(standing.best.multiple)}</b>`);
    if (standing.worst) lines.push(`worst · ${escapeHtml(standing.worst.ticker)} <b>${multiple(standing.worst.multiple)}</b>`);
  }

  if (standing.rugged) lines.push(`${standing.rugged} rugged`);

  lines.push('');
  lines.push(
    standing.priced >= comp.minSample
      ? position === undefined
        ? '<i>You are on the leaderboard.</i>'
        : `<i>You are #${position} on the leaderboard.</i>`
      : `<i>${comp.minSample - standing.priced} more priced pick${
          comp.minSample - standing.priced === 1 ? '' : 's'
        } and you are ranked.</i>`,
  );
  return lines.join('\n');
}

/**
 * Only a real `@username` is ever printed.
 *
 * A member without one is shown as the last four digits of their id — they can find their own
 * row, and nobody else can work out who it is. The alternative is Telegram's `first_name`,
 * which is free text the member chooses and is neither unique nor verified: it would let
 * anyone put a `<b>` tag into a message the channel renders as HTML, and let two people wear
 * the same name on a table that decides who is winning.
 *
 * Escaped anyway. A username cannot contain anything dangerous, and this string is going into
 * the public channel, which is exactly where "cannot" should not be load-bearing.
 */
function name(standing: Standing): string {
  if (!standing.handle) return `member ${escapeHtml(standing.memberId.slice(-4))}`;
  return escapeHtml(standing.handle.slice(0, 32));
}

function detail(standing: Standing): string {
  const parts = [`${standing.priced} picks`];
  if (standing.best) parts.push(`best ${multiple(standing.best.multiple)}`);
  return ` <i>(${parts.join(' · ')})</i>`;
}

/** Two decimals under 10x, where the difference between 1.4x and 1.8x is the whole story. */
function multiple(value: number): string {
  return value >= 10 ? `${value.toFixed(1)}x` : `${value.toFixed(2)}x`;
}

function picksPerDay(comp: CompetitionConfig): string {
  return comp.picksPerDay === 1 ? 'one pick a day' : `${comp.picksPerDay} picks a day`;
}

function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function time(now: Date): string {
  return now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
