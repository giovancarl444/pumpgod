import type { Chain } from '../types';

interface Entry {
  firstSeen: number;
  sources: string[];
  /** Taken by the first source whose call could actually reach a surface we own. */
  claimed: boolean;
  /** Message id of the call we published, so later confirmations can edit it. */
  publishedMessageId?: number;
}

/**
 * Two groups calling the same coin 10 seconds apart is the normal case, not an edge
 * case. The first one through publishes; the rest are recorded as confirmations so the
 * published message can be upgraded instead of duplicated.
 */
export class Dedupe {
  private readonly seen = new Map<string, Entry>();
  private lastSweep = 0;

  constructor(private readonly ttlMs: number) {}

  private static key(chain: Chain, address: string): string {
    // EVM addresses are case-insensitive; Solana ones are not.
    return chain === 'solana' ? `${chain}:${address}` : `${chain}:${address.toLowerCase()}`;
  }

  /**
   * Returns `first: true` for the source that gets to act on this coin. Later callers inside
   * the window come back with `first: false` plus the running confirmation list.
   *
   * `canPublish` is what stops a group we merely watch from silencing us. A shadow source has
   * nowhere to send a call, so it registers its observation — the confirmation count on the
   * public card is built from exactly these — without taking the slot that decides whether
   * our own call gets posted. Anything that can reach the channel takes the slot and holds it
   * against every later source, which is the double-post this class exists to prevent.
   */
  check(chain: Chain, address: string, sourceId: string, canPublish: boolean): { first: boolean; entry: Entry } {
    const now = Date.now();
    this.maybeSweep(now);

    const k = Dedupe.key(chain, address);
    const existing = this.seen.get(k);

    if (existing && now - existing.firstSeen < this.ttlMs) {
      if (!existing.sources.includes(sourceId)) existing.sources.push(sourceId);
      // Still unclaimed means every source through here so far was one we only observe.
      if (existing.claimed || !canPublish) return { first: false, entry: existing };
      existing.claimed = true;
      return { first: true, entry: existing };
    }

    const entry: Entry = { firstSeen: now, sources: [sourceId], claimed: canPublish };
    this.seen.set(k, entry);
    return { first: true, entry };
  }

  markPublished(chain: Chain, address: string, messageId: number) {
    const entry = this.seen.get(Dedupe.key(chain, address));
    if (entry) entry.publishedMessageId = messageId;
  }

  /** Sweeping on a timer would add a stray timer; piggybacking on traffic costs nothing. */
  private maybeSweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.seen) {
      if (now - v.firstSeen >= this.ttlMs) this.seen.delete(k);
    }
  }

  get size() {
    return this.seen.size;
  }
}
