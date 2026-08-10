import type { CompetitionConfig } from '../config';
import { escapeHtml } from '../format/call';
import { multiple } from '../format/scoreboard';
import type { Scoreboard } from '../track/stats';
import { scoreboard } from '../track/stats';
import type { TrackedCall } from '../track/tracker';
import type { Intent } from './intent';
import { BOUNDARY, MIN_SAMPLE, THIN_SAMPLE, UNKNOWN } from './persona';

/**
 * Every answer the agent can give, and where each number in it came from.
 *
 * One function per intent, and nothing in this file generates prose about a coin. The figures
 * are read out of the tracker at the moment of asking — the same tracker the pinned board and
 * the X feed read, so the agent cannot contradict our own published record. That is not a
 * detail. Two different numbers for the same call, one pinned and one in a reply, would undo
 * the only thing the channel has.
 *
 * The answers are short on purpose. This is a chat, and a bot that replies with six paragraphs
 * is a bot people mute.
 */

export interface Knowledge {
  /**
   * Live calls, not the file on disk — `Tracker.read()` lags a poll behind, and being a minute
   * stale is how the agent ends up quoting a number the channel has already moved past.
   */
  calls(): TrackedCall[];
  competition: CompetitionConfig;
  channelUrl?: string;
  /**
   * The paid tier, when there is one.
   *
   * Absent means it is not open, and the agent says exactly that. Describing a tier that does
   * not exist yet would be the first thing it ever lied about, and it would be lying to the
   * people most likely to have paid.
   */
  membership?: { priceStars: number; leadSeconds: number };
}

export function answer(intent: Intent, k: Knowledge): string {
  switch (intent) {
    case 'advice':
      return advice();
    case 'record':
      return record(board(k));
    case 'worst':
      return worst(board(k));
    case 'best':
      return best(board(k));
    case 'trust':
      return trust(board(k), k);
    case 'screen':
      return screen();
    case 'membership':
      return membership(k);
    case 'competition':
      return competition(k);
    case 'where':
      return where(k);
    case 'who':
      return who(k);
    case 'greeting':
      return who(k);
    case 'unknown':
      return UNKNOWN;
  }
}

function board(k: Knowledge): Scoreboard {
  return scoreboard(k.calls());
}

/**
 * The refusal.
 *
 * Written to be useful rather than a wall, because a bare "I can't answer that" reads as evasion
 * and gets asked again in a different shape. Pointing at the two checks anybody can run
 * themselves answers the thing behind the question — *is this going to hurt me* — without
 * answering the question that was typed.
 */
function advice(): string {
  return [
    `🚫 ${BOUNDARY}`,
    '',
    'What I can tell you is what we check before we call anything, and what our own calls ' +
      'actually did afterwards. Ask me either.',
  ].join('\n');
}

function record(b: Scoreboard): string {
  if (!b.called) {
    return 'No published calls on the record yet. When there are, every one of them is priced ' +
      'automatically for 24 hours and the numbers go on the pinned board — including the losses.';
  }

  const lines = [`📊 <b>${b.called}</b> call${b.called === 1 ? '' : 's'} published.`];

  if (b.priced) {
    lines.push(
      `${b.hit2x} hit 2x · ${b.hit5x} hit 5x · ${b.hit10x} hit 10x, of ${b.priced} we could price.`,
      `Median peak <b>${multiple(b.medianPeak)}</b>.`,
    );
  }

  const caveats: string[] = [];
  if (b.rugged) caveats.push(`${b.rugged} rugged`);
  // Named rather than buried. An unpriced call counts in the total and can never count as a
  // hit, so leaving it unsaid quietly reads as a loss — which understates us, and dishonestly.
  if (b.unpriced) caveats.push(`${b.unpriced} we could not price`);
  if (caveats.length) lines.push(caveats.join(' · ') + '.');

  // Volunteered, not waited for. The number that makes the rest believable is the bad one.
  if (b.worst) lines.push(`Worst of them: ${escapeHtml(b.worst.ticker)} at ${multiple(b.worst.multiple)}.`);

  if (b.priced < MIN_SAMPLE) lines.push('', `<i>${THIN_SAMPLE}</i>`);
  return lines.join('\n');
}

function worst(b: Scoreboard): string {
  if (!b.worst) {
    return 'Nothing has been priced long enough to have a worst yet. When it does, it goes on ' +
      'the pinned board next to the best one — that is the whole point of the board.';
  }
  return [
    `📉 Worst call so far: ${escapeHtml(b.worst.ticker)}, currently <b>${multiple(b.worst.multiple)}</b>.`,
    '',
    'It stays on the pinned board. Every group posts its winners — the losses are the reason ' +
      'to believe the rest of it.',
  ].join('\n');
}

function best(b: Scoreboard): string {
  if (!b.best) return 'Nothing priced yet, so there is no best to point at. It goes on the pinned board when there is.';
  const run = b.best.run ? ` — ${b.best.run.milestone}x of it inside the first ${Math.round(b.best.run.seconds / 60)} minutes` : '';
  return [
    `📈 Best call so far: ${escapeHtml(b.best.ticker)}, peaked at <b>${multiple(b.best.multiple)}</b>${run}.`,
    '',
    // A best call quoted on its own is the exact shape of every fake track record in this
    // space, so it never goes out unaccompanied by the denominator.
    `That is one call out of ${b.called}. Ask me for the record if you want the rest of them, ` +
      'losses included.',
  ].join('\n');
}

function trust(b: Scoreboard, k: Knowledge): string {
  const lines = [
    "🧾 Don't take my word for it — that is the design.",
    '',
    'Every call is posted in the channel with a timestamp and the market cap it was called at. ' +
      'A price is then sampled automatically every minute for 24 hours. Nothing is typed in by ' +
      'hand, nothing is deleted, and the losses stay up.',
    '',
    'So you can take any call, open the chart, and check it yourself. That is the only kind of ' +
      'track record worth anything — screenshots are free to make.',
  ];
  if (b.called) lines.push('', `There are <b>${b.called}</b> up there right now.`);
  if (k.channelUrl) lines.push(k.channelUrl);
  return lines.join('\n');
}

/**
 * What the machine actually does before a call goes out.
 *
 * Deliberately concrete. "We do thorough research" is what every group says and it persuades
 * nobody; naming the specific check — *can the owner stop you selling* — both teaches something
 * useful and demonstrates that there is a machine rather than a person with a hunch.
 */
function screen(): string {
  return [
    '🔍 Before anything is called, it is checked against the chain and the market:',
    '',
    '• <b>Freeze authority</b> — can the owner stop you selling? If that key is still live we ' +
      'do not call it, and that one cannot be overridden by anybody here.',
    '• <b>Mint authority</b> — can they still print more supply?',
    '• <b>Liquidity</b> — is there enough to get out of, and is the pool real or wash traded?',
    '• <b>Age</b> — a call that reached us late is held back rather than posted as if it were fresh.',
    '',
    'Then it is priced every minute for 24 hours, whatever it does.',
  ].join('\n');
}

function membership(k: Knowledge): string {
  if (!k.membership) {
    return [
      'There is no paid tier at the moment — every call goes to the main channel and everyone ' +
        'gets it at the same time.',
      '',
      'If that changes it will be announced in the channel, not in a DM from a bot.',
    ].join('\n');
  }
  const lead = k.membership.leadSeconds >= 60
    ? `${Math.round(k.membership.leadSeconds / 60)} minute${k.membership.leadSeconds >= 120 ? 's' : ''}`
    : `${k.membership.leadSeconds} seconds`;
  return [
    `⭐ <b>${k.membership.priceStars} Stars</b> — you get every call <b>${lead}</b> before the ` +
      'main channel.',
    '',
    'Same calls, same coins, nothing held back. The only thing being sold is the head start, ' +
      'and you can see exactly what it was worth: every public card says what the price was ' +
      'when members got it.',
  ].join('\n');
}

function competition(k: Knowledge): string {
  if (!k.competition.enabled) {
    return 'The call competition is not running at the moment. It gets announced in the channel when it is.';
  }
  const perDay = k.competition.picksPerDay === 1 ? 'One pick a day' : `${k.competition.picksPerDay} picks a day`;
  return [
    '🏆 <b>Call competition</b> — DM me <code>/submit &lt;contract address&gt;</code>.',
    '',
    `${perDay}. Your pick is priced for 24 hours by the same tracker that prices ours, and ` +
      `ranked on median peak once you have ${k.competition.minSample} priced.`,
    '',
    '<i>Your picks are never posted in the channel — only the numbers reach the table. ' +
      'A bad pick is not going up under your name.</i>',
  ].join('\n');
}

function where(k: Knowledge): string {
  if (!k.channelUrl) return 'The calls go out in the main channel. Ask an admin for the link — I have not been given one.';
  return `The calls are all here: ${k.channelUrl}`;
}

function who(k: Knowledge): string {
  const lines = [
    '👋 <b>pumpgod</b> — a call channel that publishes its own numbers.',
    '',
    'Every coin we call is timestamped and then priced automatically for 24 hours. Wins, losses ' +
      'and the ones we could not price all go on the same pinned board. Nothing is edited after ' +
      'the fact.',
    '',
    'Ask me about the record, the worst call, or what we check before calling something.',
  ];
  if (k.channelUrl) lines.push('', k.channelUrl);
  return lines.join('\n');
}
