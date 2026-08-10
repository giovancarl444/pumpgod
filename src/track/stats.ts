import type { TrackedCall } from './tracker';

/**
 * What the tracker's records add up to. Kept here rather than in the modules that publish
 * them because the X feed, the pinned message and the source scorecard all quote the same
 * numbers, and three implementations of "how did we do" would eventually disagree — in
 * public, about calls anyone can go and check.
 */

/**
 * The one rule this module exists to enforce: we only ever claim calls we actually
 * published. Shadow and dry-run calls are tracked precisely so we can evaluate sources
 * privately — posting one as ours would be a lie, and the channel is a timestamped record
 * that anybody can check it against.
 */
export function isPublished(call: TrackedCall): boolean {
  return call.outcome === 'called';
}

/**
 * Medians, not means, everywhere a "typical" call is described. One 200x drags a mean
 * somewhere useless, and the question being answered is what a normal call does.
 */
export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The best it ever got. */
export function peakMultiple(call: TrackedCall): number | undefined {
  if (!call.entryPriceUsd || !call.athPriceUsd) return undefined;
  return call.athPriceUsd / call.entryPriceUsd;
}

/**
 * Where it stands now — which is the only number that can be below 1x, and therefore the
 * only one that can describe a loss. A record built solely on peaks is the record every
 * other group publishes.
 */
export function currentMultiple(call: TrackedCall): number | undefined {
  if (!call.entryPriceUsd || !call.lastPriceUsd) return undefined;
  return call.lastPriceUsd / call.entryPriceUsd;
}

/** Milestones we recorded a time for. The rest of the run is known only by its peak. */
export const TIME_TO: Record<number, keyof TrackedCall> = {
  2: 'timeTo2xSec',
  5: 'timeTo5xSec',
  10: 'timeTo10xSec',
};

/** The largest milestone with a recorded time. */
export function timedRun(call: TrackedCall): { milestone: number; seconds: number } | undefined {
  let found: { milestone: number; seconds: number } | undefined;
  for (const milestone of [2, 5, 10]) {
    const field = TIME_TO[milestone];
    const seconds = field ? call[field] : undefined;
    if (typeof seconds === 'number') found = { milestone, seconds };
  }
  return found;
}

export function label(call: TrackedCall): string {
  return call.ticker ? `$${call.ticker}` : (call.name ?? '?');
}

export interface Standing {
  ticker: string;
  multiple: number;
  /** `run` is the biggest milestone we actually timed, which is rarely the peak itself —
   *  so it has to carry its own multiple rather than borrow the peak's. */
  run?: { milestone: number; seconds: number };
}

export interface Scoreboard {
  called: number;
  /** The denominator every rate here is against. Quoting a rate without it is the trick. */
  priced: number;
  /**
   * Calls we never got a price for. They count in `called` and can never count as a hit, so
   * they read as losses unless they are named — which understates us, and quietly, which is
   * the worse half. Anyone checking the arithmetic should be able to see where the gap went.
   */
  unpriced: number;
  hit2x: number;
  hit5x: number;
  hit10x: number;
  rugged: number;
  medianPeak: number;
  best?: Standing;
  /** By where it stands now, not by its peak — see `currentMultiple`. */
  worst?: Standing;
  /** When the record starts, so a rate is read against a window rather than a vibe. */
  since?: number;
}

export function scoreboard(calls: TrackedCall[]): Scoreboard {
  const published = calls.filter(isPublished);
  const board: Scoreboard = {
    called: published.length,
    priced: 0,
    unpriced: 0,
    hit2x: 0,
    hit5x: 0,
    hit10x: 0,
    rugged: 0,
    medianPeak: 0,
  };
  const peaks: number[] = [];

  for (const call of published) {
    if (call.rugged) board.rugged++;
    if (board.since === undefined || call.calledAt < board.since) board.since = call.calledAt;

    const peak = peakMultiple(call);
    if (peak === undefined) {
      board.unpriced++;
      continue;
    }

    board.priced++;
    peaks.push(peak);
    if (peak >= 2) board.hit2x++;
    if (peak >= 5) board.hit5x++;
    if (peak >= 10) board.hit10x++;

    if (!board.best || peak > board.best.multiple) {
      board.best = { ticker: label(call), multiple: peak, run: timedRun(call) };
    }

    const now = currentMultiple(call);
    if (now !== undefined && (!board.worst || now < board.worst.multiple)) {
      board.worst = { ticker: label(call), multiple: now };
    }
  }

  board.medianPeak = median(peaks);
  return board;
}
