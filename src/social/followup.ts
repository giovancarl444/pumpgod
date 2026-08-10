import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { money } from '../format/call';
import type { TrackedCall } from '../track/tracker';
import type { Peer, Transport } from '../telegram/transport';
import { bestDue, duration, type Milestone } from './recap';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/followed.json');

/**
 * Above this, the run is worth interrupting somebody for. Below it the reply still goes out,
 * silently — a 2x on a call nobody is watching should not put a badge on five thousand phones.
 */
const NOTIFY_FROM = 10;

/** The smallest run worth mentioning at all. A 2x is a good afternoon, not a headline. */
const MIN_MULTIPLE = 2;

export interface FollowupOptions {
  /** Overridden in tests so they cannot clear the real history and re-announce everything. */
  storePath?: string;
  minMultiple?: number;
}

export interface Followup {
  key: string;
  text: string;
  settles: string[];
  milestone: Milestone;
  peer: Peer;
  replyTo: number;
}

/**
 * Reports a call's milestones underneath the call itself.
 *
 * This is the same event the X feed posts, aimed at people who are already here. It is worth
 * doing separately because the reply lands attached to the original card: the entry price is
 * one scroll away, in a message with a timestamp nobody can edit. That is a receipt. The same
 * number in a standalone post is a claim.
 *
 * It also does the unglamorous job of making a channel with two calls a day feel inhabited,
 * without anybody having to write anything.
 */
export class Followups {
  private readonly sent = new Set<string>();
  private readonly store: string;
  private readonly minMultiple: number;

  constructor(options: FollowupOptions = {}) {
    this.store = options.storePath ?? STORE;
    this.minMultiple = options.minMultiple ?? MIN_MULTIPLE;
  }

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      for (const key of JSON.parse(readFileSync(this.store, 'utf8')) as string[]) this.sent.add(key);
    } catch (err) {
      log.warn(`could not read follow-up history: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify([...this.sent], null, 2));
    } catch (err) {
      log.warn(`could not persist follow-up history: ${(err as Error).message}`);
    }
  }

  /** Separate from sending so it can be inspected without a Telegram account existing. */
  due(calls: TrackedCall[]): Followup[] {
    const out: Followup[] = [];

    for (const call of calls) {
      // No card means nothing to answer. A call tracked from before we recorded where its
      // message went is one of these, and it stays silent rather than posting out of context.
      if (!call.postChatId || !call.postMessageId) continue;

      const due = bestDue(call, (key) => this.sent.has(key), this.minMultiple);
      if (!due) continue;

      out.push({
        ...due,
        text: followupText(call, due.milestone),
        peer: { id: call.postChatId, threadId: call.postThreadId },
        replyTo: call.postMessageId,
      });
    }
    return out;
  }

  async run(transport: Transport, calls: TrackedCall[]): Promise<void> {
    const pending = this.due(calls);
    if (!pending.length) return;

    for (const followup of pending) {
      try {
        await transport.send(followup.peer, followup.text, {
          stage: 'send.followup',
          replyTo: followup.replyTo,
          silent: followup.milestone < NOTIFY_FROM,
        });
        this.sent.add(followup.key);
        for (const settled of followup.settles) this.sent.add(settled);
        log.info(`↳ ${followup.key} reported under the call`);
      } catch (err) {
        // Left unmarked so the next sweep tries again. A milestone is worth saying late.
        log.warn(`could not report ${followup.key}: ${(err as Error).message}`);
      }
    }

    this.persist();
  }
}

/**
 * Deliberately not a second call card. It is one line saying what the coin above it did, and
 * how long it took — the reader already has the entry, the chain and the buy link in the
 * message this is attached to, and repeating them would read as calling the coin twice.
 */
function followupText(call: TrackedCall, milestone: Milestone): string {
  const ticker = call.ticker ? `$${call.ticker}` : (call.name ?? 'this');
  const parts = [`🚀 <b>${ticker} ${milestone}x</b>`];

  if (call.entryMcUsd) {
    const from = money(call.entryMcUsd);
    const to = money(call.entryMcUsd * milestone);
    if (from && to) parts.push(`${from} → ${to}`);
  }

  const seconds = Math.round((Date.now() - call.calledAt) / 1000);
  if (seconds > 0) parts.push(`in ${duration(seconds)}`);

  return parts.join(' · ');
}
