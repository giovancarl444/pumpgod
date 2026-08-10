import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { Tracker, type TrackedCall } from '../track/tracker';
import { bestDue, dailyRecap, milestonePost, type RecapOptions } from './recap';
import { loadCredentials, postTweet, tweetLength, TWEET_LIMIT, type XCredentials } from './x';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/posted.json');

export interface Post {
  /** Stable identity for what this post is about, so it is never sent twice. */
  key: string;
  text: string;
  /** The lower milestones this post speaks for. Marked only once it has actually gone out,
   *  so a 5x can never trail a 10x, while a post that failed still gets another attempt. */
  settles: string[];
}

export interface PosterOptions extends RecapOptions {
  dailyRecap: boolean;
  /** Where the sent-history lives. Overridden in tests so they cannot clear the real one —
   *  an emptied history means every past milestone is posted again. */
  storePath?: string;
}

/**
 * Turns the outcome tracker into an X feed.
 *
 * The feed is the growth engine: a call group is judged on calls that ran, and every one of
 * ours is already recorded with an entry, a peak and a time. Nothing here decides anything
 * new — it only publishes what the tracker measured, which is why it can be trusted to run
 * unattended.
 */
export class Poster {
  private readonly sent = new Set<string>();
  private readonly credentials?: XCredentials;
  private readonly store: string;

  constructor(
    private readonly options: PosterOptions,
    credentials = loadCredentials(),
  ) {
    this.credentials = credentials;
    this.store = options.storePath ?? STORE;
  }

  get enabled(): boolean {
    return this.credentials !== undefined;
  }

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      for (const key of JSON.parse(readFileSync(this.store, 'utf8')) as string[]) this.sent.add(key);
    } catch (err) {
      log.warn(`could not read posted history: ${(err as Error).message}`);
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify([...this.sent], null, 2));
    } catch (err) {
      log.warn(`could not persist posted history: ${(err as Error).message}`);
    }
  }

  /**
   * What is worth posting right now, newest milestone first. Separate from sending so
   * `npm run recap` can show exactly what would go out without an X account existing.
   */
  due(calls: TrackedCall[], now = new Date()): Post[] {
    const posts: Post[] = [];

    for (const call of calls) {
      const due = bestDue(call, (key) => this.sent.has(key), this.options.minMultiple);
      if (!due) continue;

      const text = milestonePost(call, due.milestone, this.options);
      if (text) posts.push({ key: due.key, text, settles: due.settles });
    }

    if (this.options.dailyRecap) {
      const recap = this.dueRecap(calls, now);
      if (recap) posts.push(recap);
    }
    return posts;
  }

  /** Yesterday's scoreboard, once yesterday is actually over. */
  private dueRecap(calls: TrackedCall[], now: Date): Post | undefined {
    const day = new Date(now);
    day.setDate(day.getDate() - 1);

    // Local date parts, not toISOString: the key has to name the same day the window covers
    // and the post prints, or east of UTC the run after midnight files under the wrong date.
    const key = `daily:${localDate(day)}`;
    if (this.sent.has(key)) return undefined;

    const from = new Date(day);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);

    const mine = calls.filter((c) => c.calledAt >= from.getTime() && c.calledAt < to.getTime());
    const text = dailyRecap(mine, day, this.options);
    return text ? { key, text, settles: [] } : undefined;
  }

  async run(calls: TrackedCall[] = Tracker.read(), now = new Date()): Promise<void> {
    if (!this.credentials) return;

    const posts = this.due(calls, now);
    if (!posts.length) return;

    for (const post of posts) {
      if (tweetLength(post.text) > TWEET_LIMIT) {
        log.warn(`skipping an over-long post (${tweetLength(post.text)} chars): ${post.key}`);
        this.sent.add(post.key);
        continue;
      }

      const result = await postTweet(this.credentials, post.text);
      if (result.ok) {
        log.info(`𝕏 posted ${post.key} → ${result.id}`);
        this.sent.add(post.key);
        for (const settled of post.settles) this.sent.add(settled);
      } else {
        // Left unmarked deliberately: a failed post should be retried on the next sweep.
        log.warn(`𝕏 post failed (${post.key}): ${result.reason}`);
      }
    }

    this.persist();
  }
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
