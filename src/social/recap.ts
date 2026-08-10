import type { TrackedCall } from '../track/tracker';
import { money } from '../format/call';

/** Multiples worth telling anyone about. A 2x is a good afternoon, not a headline. */
export const MILESTONES = [2, 5, 10, 25, 50, 100] as const;
export type Milestone = (typeof MILESTONES)[number];

export interface RecapOptions {
  /** Public Telegram link. Without it a post is proof with nowhere to convert. */
  channelUrl?: string;
  /** Lowest multiple that earns a post. Below this, posting trains people to scroll past. */
  minMultiple: number;
}

/**
 * The one rule this module exists to enforce: we only ever claim calls we actually
 * published. Shadow and dry-run calls are tracked precisely so we can evaluate sources
 * privately — posting one as ours would be a lie, and the public channel is a timestamped
 * record that anybody can check it against.
 */
export function isPublished(call: TrackedCall): boolean {
  return call.outcome === 'called';
}

export function peakMultiple(call: TrackedCall): number | undefined {
  if (!call.entryPriceUsd || !call.athPriceUsd) return undefined;
  return call.athPriceUsd / call.entryPriceUsd;
}

const TIME_TO: Record<number, keyof TrackedCall> = {
  2: 'timeTo2xSec',
  5: 'timeTo5xSec',
  10: 'timeTo10xSec',
};

/** Milestones this call has reached, largest first. */
export function reached(call: TrackedCall, minMultiple: number): Milestone[] {
  const peak = peakMultiple(call);
  if (peak === undefined) return [];
  return MILESTONES.filter((m) => m >= minMultiple && peak >= m).reverse();
}

/**
 * The post that does the actual recruiting: a number, how fast it happened, and where to
 * be next time. Kept short deliberately — the multiple is the argument, everything else
 * is evidence for it.
 */
export function milestonePost(call: TrackedCall, milestone: Milestone, opts: RecapOptions): string | undefined {
  if (!isPublished(call)) return undefined;
  const peak = peakMultiple(call);
  if (peak === undefined || peak < milestone) return undefined;

  const ticker = call.ticker ? `$${call.ticker}` : (call.name ?? 'it');
  const lines = [`${ticker} did ${milestone}x ⚡`, ''];

  // Entry × the measured multiple, rather than the recorded peak cap. The two can disagree
  // when they were sampled a moment apart, and a post whose own numbers do not multiply out
  // is the first thing a sceptic notices.
  if (call.entryMcUsd) {
    const at = money(call.entryMcUsd);
    const now = money(call.entryMcUsd * milestone);
    if (at && now) lines.push(`called at ${at} → ${now}`);
  }

  const seconds = elapsedTo(call, milestone);
  if (seconds !== undefined) lines.push(duration(seconds));

  if (opts.channelUrl) lines.push('', opts.channelUrl);
  return lines.join('\n');
}

/** How long the run took, where we recorded it. Only the tracked milestones have a time. */
function elapsedTo(call: TrackedCall, milestone: Milestone): number | undefined {
  const field = TIME_TO[milestone];
  const value = field ? call[field] : undefined;
  return typeof value === 'number' ? value : undefined;
}

export interface DayStats {
  called: number;
  hit2x: number;
  hit5x: number;
  hit10x: number;
  /** `run` is the biggest milestone we actually timed, which is rarely the peak itself —
   *  so it has to carry its own multiple rather than borrow the peak's. */
  best?: { ticker: string; multiple: number; run?: { milestone: number; seconds: number } };
}

/** The largest milestone with a recorded time. Times exist only for the tracked ones. */
function timedRun(call: TrackedCall): { milestone: number; seconds: number } | undefined {
  let found: { milestone: number; seconds: number } | undefined;
  for (const milestone of [2, 5, 10]) {
    const field = TIME_TO[milestone];
    const seconds = field ? call[field] : undefined;
    if (typeof seconds === 'number') found = { milestone, seconds };
  }
  return found;
}

export function summarise(calls: TrackedCall[]): DayStats {
  const published = calls.filter(isPublished);
  const stats: DayStats = { called: published.length, hit2x: 0, hit5x: 0, hit10x: 0 };

  for (const call of published) {
    const peak = peakMultiple(call);
    if (peak === undefined) continue;
    if (peak >= 2) stats.hit2x++;
    if (peak >= 5) stats.hit5x++;
    if (peak >= 10) stats.hit10x++;

    if (!stats.best || peak > stats.best.multiple) {
      stats.best = {
        ticker: call.ticker ? `$${call.ticker}` : (call.name ?? '?'),
        multiple: peak,
        run: timedRun(call),
      };
    }
  }
  return stats;
}

/**
 * A day's work in one post. This is the honest version of the format every call group uses:
 * the denominator is there, so a good day reads as a good day rather than a selected one.
 */
export function dailyRecap(calls: TrackedCall[], day: Date, opts: RecapOptions): string | undefined {
  const stats = summarise(calls);
  if (!stats.called) return undefined;

  const date = day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const lines = [`pumpgod · ${date}`, '', `${stats.called} call${stats.called === 1 ? '' : 's'}`];

  const hits = [
    stats.hit2x && `${stats.hit2x} × 2x`,
    stats.hit5x && `${stats.hit5x} × 5x`,
    stats.hit10x && `${stats.hit10x} × 10x`,
  ].filter(Boolean) as string[];
  lines.push(hits.length ? hits.join(' · ') : 'none ran — that happens');

  if (stats.best && stats.best.multiple >= 2) {
    // The time has to name the milestone it belongs to. "12.4x in 2m" reads as the peak
    // taking two minutes when 2m was only the time to 2x — a claim the chart disproves.
    const { run } = stats.best;
    const time = run ? ` · ${run.milestone}x in ${duration(run.seconds)}` : '';
    lines.push(`best ${stats.best.ticker} ${stats.best.multiple.toFixed(1)}x${time}`);
  }

  if (opts.channelUrl) lines.push('', opts.channelUrl);
  return lines.join('\n');
}

export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
