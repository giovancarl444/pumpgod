import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/watched.json');

export interface WatchMark {
  /** The newest message id we have already considered on this channel. */
  lastId: number;
  /** When we last managed to read the channel at all. */
  checkedAt: number;
  /** Consecutive passes that returned nothing readable. */
  misses: number;
}

/**
 * How far through each watched channel we have read.
 *
 * The tracker already refuses to record the same coin twice for the same source, so this is not
 * what stops duplicates — it is what stops us *paying* for them. Without it every pass would
 * re-resolve twenty posts per channel against DexScreener and the candle API, eighty channels
 * over, for answers we already have. With it a quiet channel costs one page fetch and nothing
 * else.
 *
 * `misses` is the other half. A channel that goes private, renames itself or turns its preview
 * off returns an empty page forever, and there is no error to notice — so the count is the only
 * way a dead handle ever gets reported rather than silently costing a request every pass.
 */
export class Watched {
  private marks = new Map<string, WatchMark>();

  constructor(private readonly store = STORE) {}

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      const raw = JSON.parse(readFileSync(this.store, 'utf8')) as Record<string, WatchMark>;
      for (const [handle, mark] of Object.entries(raw)) this.marks.set(handle, mark);
      log.debug(`loaded read marks for ${this.marks.size} channels`);
    } catch (err) {
      log.warn(`could not read watch marks: ${(err as Error).message}`);
    }
  }

  lastId(handle: string): number | undefined {
    return this.marks.get(handle)?.lastId;
  }

  /** A channel we have never read. Its first pass is a cold start and is capped harder. */
  isNew(handle: string): boolean {
    return !this.marks.has(handle);
  }

  misses(handle: string): number {
    return this.marks.get(handle)?.misses ?? 0;
  }

  /**
   * Advance to `lastId`, whether or not anything in the page was recorded.
   *
   * Posts we deliberately skipped — recaps, chatter, anything past the age cut — advance the
   * mark too. They were considered and rejected, and re-considering them next pass would reach
   * the same answer at the same cost.
   */
  seen(handle: string, lastId: number, at = Date.now()): void {
    const mark = this.marks.get(handle);
    if (mark) {
      mark.lastId = Math.max(mark.lastId, lastId);
      mark.checkedAt = at;
      mark.misses = 0;
    } else {
      this.marks.set(handle, { lastId, checkedAt: at, misses: 0 });
    }
  }

  /** Nothing came back. Recorded so a handle that has gone dark can be named rather than guessed at. */
  missed(handle: string, at = Date.now()): number {
    const mark = this.marks.get(handle);
    if (mark) {
      mark.misses += 1;
      mark.checkedAt = at;
      return mark.misses;
    }
    // Never read successfully. Starting at id 0 means the first page that does arrive is
    // treated as a cold start rather than as twenty brand-new calls.
    this.marks.set(handle, { lastId: 0, checkedAt: at, misses: 1 });
    return 1;
  }

  list(): Array<{ handle: string } & WatchMark> {
    return [...this.marks.entries()].map(([handle, mark]) => ({ handle, ...mark }));
  }

  persist(): void {
    const out: Record<string, WatchMark> = {};
    for (const [handle, mark] of this.marks) out[handle] = mark;
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify(out, null, 2));
    } catch (err) {
      log.warn(`could not write watch marks: ${(err as Error).message}`);
    }
  }
}
