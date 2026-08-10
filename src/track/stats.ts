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

/**
 * One caller's record — a rival group, our own `manual`, or a member of the channel.
 *
 * The same shape for all three because they are the same question asked of different people,
 * and because a member leaderboard computed differently from the pinned board would sooner or
 * later put two contradicting numbers in the same channel.
 */
export interface CallerRecord {
  /** The `sourceId` these calls were recorded under. */
  id: string;
  picks: number;
  priced: number;
  unpriced: number;
  medianPeak: number;
  /** Counts, not percentages — a rate with the denominator stripped off is the trick. */
  hit2x: number;
  hit5x: number;
  hit10x: number;
  rugged: number;
  medianEntryMcUsd: number;
  medianTimeTo2xSec?: number;
  best?: Standing;
  /** By where it stands now, not by its peak. */
  worst?: Standing;
  firstPickAt?: number;
  lastPickAt?: number;
}

/**
 * Splits tracked calls by who called them.
 *
 * Hit rates come from `peakMultiple`, not from whether we happened to record a `timeTo2xSec`.
 * The timed fields only exist if the crossing happened while we were watching, so a restart
 * mid-run silently turns a 3x into a miss — fine for a private hint about a source, not fine
 * for a number anybody is ranked by in public.
 */
export function byCaller(calls: TrackedCall[]): CallerRecord[] {
  const groups = new Map<string, TrackedCall[]>();
  for (const call of calls) {
    const group = groups.get(call.sourceId);
    if (group) group.push(call);
    else groups.set(call.sourceId, [call]);
  }
  return [...groups.entries()].map(([id, group]) => summarise(id, group));
}

function summarise(id: string, calls: TrackedCall[]): CallerRecord {
  const record: CallerRecord = {
    id,
    picks: calls.length,
    priced: 0,
    unpriced: 0,
    medianPeak: 0,
    hit2x: 0,
    hit5x: 0,
    hit10x: 0,
    rugged: 0,
    medianEntryMcUsd: 0,
  };

  const peaks: number[] = [];
  const times: number[] = [];

  for (const call of calls) {
    if (call.rugged) record.rugged++;
    if (record.firstPickAt === undefined || call.calledAt < record.firstPickAt) record.firstPickAt = call.calledAt;
    if (record.lastPickAt === undefined || call.calledAt > record.lastPickAt) record.lastPickAt = call.calledAt;
    if (call.timeTo2xSec !== undefined) times.push(call.timeTo2xSec);

    const peak = peakMultiple(call);
    if (peak === undefined) {
      record.unpriced++;
      continue;
    }

    record.priced++;
    peaks.push(peak);
    if (peak >= 2) record.hit2x++;
    if (peak >= 5) record.hit5x++;
    if (peak >= 10) record.hit10x++;

    if (!record.best || peak > record.best.multiple) {
      record.best = { ticker: label(call), multiple: peak, run: timedRun(call) };
    }

    const now = currentMultiple(call);
    if (now !== undefined && (!record.worst || now < record.worst.multiple)) {
      record.worst = { ticker: label(call), multiple: now };
    }
  }

  record.medianPeak = median(peaks);
  record.medianEntryMcUsd = median(calls.map((c) => c.entryMcUsd ?? 0).filter(Boolean));
  if (times.length) record.medianTimeTo2xSec = median(times);
  return record;
}

/**
 * Best first — but anybody with too small a sample sorts to the bottom however good they look.
 *
 * Three lucky picks beating a hundred measured ones is not a leaderboard, it is a lottery
 * result, and the person on top of it knows it. `minSample` counts *priced* picks rather than
 * submitted ones, because a pick we could not price says nothing about the person who made it.
 */
export function rank<T extends CallerRecord>(records: T[], minSample: number): T[] {
  return [...records].sort((a, b) => {
    const aThin = a.priced < minSample;
    const bThin = b.priced < minSample;
    if (aThin !== bThin) return aThin ? 1 : -1;
    if (b.medianPeak !== a.medianPeak) return b.medianPeak - a.medianPeak;
    // A tie on the median — which is common early, when everyone's median is 0 or 1 — is
    // broken by who has shown more of it, not by Map insertion order.
    return b.priced - a.priced;
  });
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
