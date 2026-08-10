import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { renderDigest } from '../format/scoreboard';
import { log } from '../log';
import type { Peer, Transport } from '../telegram/transport';
import { isPublished, scoreboard } from '../track/stats';
import type { TrackedCall } from '../track/tracker';

/**
 * The agent speaking without being spoken to.
 *
 * ## Why this is the dangerous half
 *
 * Everything else the agent does is a reply: somebody typed something, and the worst case is an
 * unhelpful answer to one person. This posts into the channel on its own, on a timer, from a
 * daemon that restarts whenever a source file changes. The failure mode is not a bad sentence —
 * it is the channel filling with them while nobody is watching, which is unrecoverable in the
 * only currency this project has.
 *
 * So it is built to be boring, and three separate things have to be true before it says a word:
 *
 * 1. `AGENT_BROADCAST` is on. It defaults off, and the daemon is normally run with `LIVE=true`
 *    against the real channel — a flag defaulting on would mean the first hot-restart after
 *    writing this file posted to it.
 * 2. A full interval has passed *by the clock on disk*, not since the process started. Without
 *    that, restarting the daemon eleven times in an evening is eleven digests.
 * 3. There is something true to say. A day with no calls produces no post at all, rather than
 *    a receipt for nothing.
 *
 * ## What it is allowed to say
 *
 * One thing: the last 24 hours of our own published calls, worst one included, rendered from
 * the same `scoreboard()` the pinned board uses. There is no phrasing model here and no room
 * for one — see `src/agent/agent.ts` for why the reactive half has no generator either. A
 * proactive message is the same argument with the stakes multiplied by everyone in the channel.
 */

export const STORE = resolve(ROOT, 'data/broadcast.json');

/** A day. The digest is a receipt, and a receipt issued twice a day is an advert. */
const EVERY_MS = 24 * 60 * 60 * 1000;

/** The window the digest describes. Kept equal to the interval so no call is counted twice. */
const WINDOW_MS = EVERY_MS;

interface BroadcastState {
  /** When we last posted, so the interval survives a restart. */
  lastAt: number;
}

function read(store: string): BroadcastState | undefined {
  if (!existsSync(store)) return undefined;
  try {
    return JSON.parse(readFileSync(store, 'utf8')) as BroadcastState;
  } catch (err) {
    log.warn(`could not read ${store}: ${(err as Error).message}`);
    return undefined;
  }
}

function write(state: BroadcastState, store: string): void {
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify(state, null, 2));
}

export interface BroadcastOptions {
  enabled: boolean;
  store?: string;
  everyMs?: number;
  windowMs?: number;
  now?: () => number;
}

export class Broadcast {
  private state?: BroadcastState;
  private readonly store: string;
  private readonly everyMs: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: BroadcastOptions) {
    this.store = opts.store ?? STORE;
    this.everyMs = opts.everyMs ?? EVERY_MS;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  load(): void {
    if (!this.opts.enabled) return;
    this.state = read(this.store);

    // A first run has no mark, and treating "never posted" as "overdue" would fire a digest
    // the moment the flag is switched on — most likely while somebody is watching the logs to
    // see whether switching it on was safe. The clock starts now and the first post is a full
    // interval away, which is also long enough to turn the flag back off.
    if (!this.state) {
      this.state = { lastAt: this.now() };
      write(this.state, this.store);
      log.info(`broadcast on — first digest in ${Math.round(this.everyMs / 3600_000)}h`);
    }
  }

  /**
   * The message to post, or `undefined` for "not now" — which is the usual answer.
   *
   * Split out from `run` so the decision can be tested without a transport, and so
   * `npm run digest` can print exactly what would go out without anything going out.
   */
  due(calls: TrackedCall[]): string | undefined {
    if (!this.opts.enabled || !this.state) return undefined;

    const at = this.now();
    if (at - this.state.lastAt < this.everyMs) return undefined;

    // Windowed on `calledAt` rather than on when the price last moved: the digest is a receipt
    // for the calls we made in a period, and a coin called last week that ran today belongs to
    // last week's receipt. `isPublished` is the same single gate the board uses — a shadow row
    // or a member's pick reaching this would be us claiming a call we never made.
    const window = calls.filter((c) => isPublished(c) && at - c.calledAt <= this.windowMs);
    return renderDigest(scoreboard(window), Math.round(this.windowMs / 3600_000));
  }

  /**
   * Posts the digest if one is due.
   *
   * The clock advances only on a successful send. A failed post that still moved the mark would
   * skip that day's receipt entirely and leave a hole in the record with no trace of why.
   */
  async run(transport: Transport, peer: Peer, calls: TrackedCall[]): Promise<void> {
    const text = this.due(calls);
    if (!text || !this.state) return;

    try {
      await transport.send(peer, text, { silent: true });
      this.state.lastAt = this.now();
      write(this.state, this.store);
      log.info('posted the daily digest');
    } catch (err) {
      log.warn(`could not post the daily digest: ${(err as Error).message}`);
    }
  }
}
