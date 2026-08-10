import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/members.json');

/** How far back submission times are kept. Only the rate limit reads them. */
const KEEP_DAYS = 30;

export interface MemberRecord {
  /** Telegram user id. The competition key, because a handle can be changed or given away. */
  id: string;
  /**
   * The latest `@username`, refreshed on every message because people rename themselves.
   *
   * A username or nothing — never Telegram's `first_name`. A first name is free text the member
   * picks and is neither unique nor verified, so putting one on a public table both invites
   * impersonation and hands an HTML message a string its author chose.
   */
  handle?: string;
  joinedAt: number;
  /**
   * When each pick was submitted, oldest first.
   *
   * Times only. What a pick *did* lives in the tracker under `member:<id>` and is never copied
   * here — two records of the same number is two numbers, and the one on a public leaderboard
   * would eventually be the stale one.
   */
  picks: number[];
}

/**
 * Who is in the competition, and when they last picked.
 *
 * This exists for exactly two things the tracker cannot answer. A `TrackedCall` has no display
 * name, so a leaderboard built from it alone is a table of numeric user ids. And `Tracker.track`
 * silently merges a repeat of the same coin, so counting submissions from it would let one
 * person re-submit their way around the daily limit.
 */
export class Members {
  private members = new Map<string, MemberRecord>();

  constructor(private readonly store = STORE) {}

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      const raw = JSON.parse(readFileSync(this.store, 'utf8')) as MemberRecord[];
      for (const m of raw) this.members.set(m.id, m);
      log.debug(`loaded ${this.members.size} competition members`);
    } catch (err) {
      log.warn(`could not read members: ${(err as Error).message}`);
    }
  }

  /** First sight enrols them; every sight after refreshes the handle. */
  upsert(id: string, handle?: string): MemberRecord {
    const existing = this.members.get(id);
    if (existing) {
      if (handle && handle !== existing.handle) {
        existing.handle = handle;
        this.persist();
      }
      return existing;
    }

    const created: MemberRecord = { id, handle, joinedAt: Date.now(), picks: [] };
    this.members.set(id, created);
    this.persist();
    return created;
  }

  find(id: string): MemberRecord | undefined {
    return this.members.get(id);
  }

  notePick(member: MemberRecord, at = Date.now()): void {
    member.picks.push(at);
    this.persist();
  }

  /**
   * Picks inside a rolling window. Rolling rather than per calendar day, because a limit that
   * resets at midnight is a limit that allows two days' worth back to back — and in a
   * competition that is not a nuisance, it is an edge over everyone who did not notice.
   */
  pickedSince(id: string, now: number, windowMs: number): number {
    const member = this.members.get(id);
    if (!member) return 0;
    return member.picks.filter((at) => now - at < windowMs).length;
  }

  /** When the oldest pick in the current window drops out, freeing a slot. */
  nextPickAt(id: string, now: number, windowMs: number, limit: number): number | undefined {
    const member = this.members.get(id);
    if (!member) return undefined;
    const inWindow = member.picks.filter((at) => now - at < windowMs).sort((a, b) => a - b);
    if (inWindow.length < limit) return undefined;
    // The one that has to expire is the `limit`-th from the end, not the oldest overall.
    return inWindow[inWindow.length - limit]! + windowMs;
  }

  list(): MemberRecord[] {
    return [...this.members.values()];
  }

  get size(): number {
    return this.members.size;
  }

  private persist(): void {
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    // Times age out; the member never does. Somebody who picked once in March is still owed
    // their name next to that pick when it turns up on a leaderboard.
    for (const member of this.members.values()) {
      member.picks = member.picks.filter((at) => at > cutoff);
    }

    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify(this.list(), null, 2));
    } catch (err) {
      log.warn(`could not write members: ${(err as Error).message}`);
    }
  }
}
