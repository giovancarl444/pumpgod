import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CompetitionConfig } from '../config';
import { ROOT } from '../config';
import { duration, escapeHtml, money } from '../format/call';
import { log } from '../log';
import { memberIdFrom, type Standing } from '../pipeline/member';
import type { Peer, Transport } from '../telegram/transport';
import type { TrackedCall } from '../track/tracker';
import { reached, timeToMilestone, type Milestone } from './recap';

const STORE = resolve(ROOT, 'data/alerted.json');

/**
 * The smallest run worth a message. Lower than the channel's bar on purpose: a 2x on somebody
 * else's call is a good afternoon, and a 2x on your own is the reason you came back.
 */
const MIN_MULTIPLE = 2;

/**
 * The part of the competition this needs — who is where on the table, computed from the same
 * snapshot the pinned board is computed from. Narrower than `MemberHandlers` so a test can
 * stand one up without a tracker, and so nothing here can reach `submit`.
 */
export interface Board {
  leaderboard(calls?: TrackedCall[]): Standing[];
}

export interface AlertOptions {
  /** Overridden in tests so they cannot clear the real history and re-announce everything. */
  storePath?: string;
  minMultiple?: number;
}

export interface Alert {
  key: string;
  text: string;
  settles: string[];
  milestone: Milestone;
  /** Always the member's own DM, derived from the record. See the note on `due`. */
  peer: Peer;
}

/**
 * Tells a member when the coin they entered actually runs.
 *
 * Without this the competition is a table you have to remember to go and look at, and a member
 * whose pick 10x'd overnight finds out by typing `/me` — if it occurs to them. The pick is the
 * one thing in this product that is *theirs*, so it is the one event worth interrupting somebody
 * for, and it arrives at the exact moment they are most likely to tell a friend.
 *
 * It is also where the nudge belongs. A member below the sample threshold is told how many
 * priced picks they still need rather than a position, because "3 more and you are on the table"
 * asks for the next entry at the only moment they want to give one.
 */
export class PickAlerts {
  private readonly sent = new Set<string>();
  private readonly store: string;
  private readonly minMultiple: number;

  constructor(
    private readonly board: Board,
    private readonly competition: CompetitionConfig,
    options: AlertOptions = {},
  ) {
    this.store = options.storePath ?? STORE;
    this.minMultiple = options.minMultiple ?? MIN_MULTIPLE;
  }

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      for (const key of JSON.parse(readFileSync(this.store, 'utf8')) as string[]) this.sent.add(key);
    } catch (err) {
      log.warn(`could not read pick alert history: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify([...this.sent], null, 2));
    } catch (err) {
      log.warn(`could not persist pick alert history: ${(err as Error).message}`);
    }
  }

  /**
   * Separate from sending so it can be inspected without a Telegram account existing.
   *
   * This is the one place in the codebase that deliberately acts on a call `isPublished` would
   * refuse, so the gate it uses instead has to be at least as tight. It is: the outcome must be
   * `member`, and the destination is read out of that record's own `member:<id>` source id
   * rather than from config — so there is no value any of this could hold that resolves to the
   * channel. `RANK` keeps `member` above `called`, which means a pick can never climb into the
   * published region and be picked up by anything that publishes.
   */
  due(calls: TrackedCall[]): Alert[] {
    const picks = calls.filter((c) => c.outcome === 'member');
    if (!picks.length) return [];

    // Ranked once for the whole sweep, off the same array. Two reads a poll apart would put two
    // different positions for one member into two messages sent seconds from each other.
    const board = this.board.leaderboard(picks);
    const out: Alert[] = [];

    for (const call of picks) {
      const memberId = memberIdFrom(call.sourceId);
      if (!memberId) continue;

      // A retired pick's peak can move one last time, when the true high is read off the chart
      // at the retirement boundary. That correction belongs in the score, which reads it, and
      // not in a notification — "your pick hit 5x" about yesterday is worse than silence.
      if (call.retired) continue;

      const hit = reached(call, this.minMultiple);
      const best = hit[0];
      if (best === undefined) continue;

      const key = alertKey(call, best);
      if (this.sent.has(key)) continue;

      out.push({
        key,
        milestone: best,
        settles: hit.map((m) => alertKey(call, m)),
        text: alertText(call, best, standingLine(board, memberId, this.competition.minSample)),
        peer: { id: memberId },
      });
    }
    return out;
  }

  async run(transport: Transport, calls: TrackedCall[]): Promise<void> {
    const pending = this.due(calls);
    if (!pending.length) return;

    for (const alert of pending) {
      try {
        await transport.send(alert.peer, alert.text, { stage: 'send.pickalert' });
        this.mark(alert);
        log.info(`🎯 told member ${alert.peer.id} their pick hit ${alert.milestone}x`);
      } catch (err) {
        const reason = (err as Error).message;
        if (!permanent(reason)) {
          // Left unmarked so the next sweep tries again. A milestone is worth saying late.
          log.warn(`could not tell member ${alert.peer.id} about ${alert.milestone}x: ${reason}`);
          continue;
        }
        // Nothing about the next sweep will be different, and the sweep is every minute for as
        // long as the pick lives. Marked done so one member who blocked the bot does not become
        // a permanent stream of warnings that hides a real one.
        this.mark(alert);
        log.debug(`member ${alert.peer.id} cannot be messaged (${reason}) — not retrying`);
      }
    }

    this.persist();
  }

  private mark(alert: Alert): void {
    this.sent.add(alert.key);
    for (const settled of alert.settles) this.sent.add(settled);
  }
}

/**
 * Scoped to the member, not just to the coin.
 *
 * The channel's key is `chain:address:Nx`, which is right there because we call a coin once.
 * Here two members can hold the same token, and a shared key would mean the second of them
 * silently never hearing about their own pick.
 */
function alertKey(call: TrackedCall, milestone: Milestone): string {
  return `${call.sourceId}:${call.chain}:${call.address}:${milestone}x`;
}

/**
 * Where they stand, or what is left before standing is a thing they can do.
 *
 * `rank()` sorts everyone under the sample threshold to the bottom, so an index in the ranked
 * array is a real position for anyone above it — and is meaningless for anyone below, which is
 * why those are told a count instead.
 */
function standingLine(board: Standing[], memberId: string, minSample: number): string | undefined {
  const at = board.findIndex((s) => s.memberId === memberId);
  const mine = board[at];
  if (!mine) return undefined;

  if (mine.priced >= minSample) {
    const ranked = board.filter((s) => s.priced >= minSample).length;
    return `You are <b>#${at + 1}</b> of ${ranked} on the leaderboard.`;
  }

  const need = minSample - mine.priced;
  return `<b>${need}</b> more priced pick${need === 1 ? '' : 's'} and you are on the table.`;
}

/**
 * Short, and about them rather than about us.
 *
 * The entry is multiplied out rather than quoted from the recorded peak: the two are sampled a
 * moment apart and can disagree, and a message whose own numbers do not multiply out is the
 * first thing anyone notices — particularly in the one message a member is most likely to
 * screenshot.
 */
function alertText(call: TrackedCall, milestone: Milestone, standing: string | undefined): string {
  // Escaped because a symbol is whatever the deployer typed into the contract, and this is a
  // message we send as HTML. See `tokenText`.
  const ticker = call.ticker ? `$${escapeHtml(call.ticker)}` : escapeHtml(call.name ?? 'your pick');
  const lines = [`🎯 <b>Your pick ${ticker} hit ${milestone}x</b>`, ''];

  const move: string[] = [];
  if (call.entryMcUsd) {
    const from = money(call.entryMcUsd);
    const to = money(call.entryMcUsd * milestone);
    if (from && to) move.push(`${from} → ${to}`);
  }

  // The recorded time where there is one, and time-since-called where there is not. They are
  // the same number for a milestone we watched happen, and the recorded one is right after a
  // restart, which is exactly when the fallback would overstate how long the run took.
  const seconds = timeToMilestone(call, milestone) ?? Math.round((Date.now() - call.calledAt) / 1000);
  if (seconds > 0) move.push(`in ${duration(seconds)}`);
  if (move.length) lines.push(move.join(' '));

  if (standing) lines.push('', standing);
  return lines.join('\n');
}

/**
 * A send that will fail the same way every minute until the pick retires.
 *
 * Telegram says so in words rather than in a code worth branching on — 403 covers both "this
 * person blocked the bot", which is permanent, and a handful of transient rights problems that
 * are not. The description is the only thing that separates them.
 */
function permanent(message: string): boolean {
  return /blocked|deactivated|chat not found|user not found|can't initiate/i.test(message);
}
