import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { log } from '../log';
import type { Chain } from '../types';

const STORE = resolve(ROOT, 'data/promos.json');

/** How many days of orders are kept. Long enough to answer "you charged me and posted nothing". */
const KEEP_DAYS = 90;

export type PromoState =
  /** Invoiced, not paid. Most orders die here — people open the invoice and think better of it. */
  | 'invoiced'
  /** Money in, card not up. Only ever momentary; found on disk it means we crashed owing one. */
  | 'paid'
  /** Paid and posted. The only state that got what it paid for. */
  | 'posted'
  /** Paid, then refunded — always because we could not deliver. */
  | 'refunded'
  /** Paid, delivery failed, and the refund failed too. Needs a human. */
  | 'owed'
  /** Never charged: the invoice itself did not get out. Kept so a retry is not blocked. */
  | 'void';

export interface PromoOrder {
  /** Also the invoice payload, so a receipt names its own order without a lookup table. */
  id: string;
  state: PromoState;
  buyerId: string;
  buyerHandle?: string;
  chain: Chain;
  address: string;
  ticker?: string;
  name?: string;
  stars: number;
  createdAt: number;
  paidAt?: number;
  postedAt?: number;
  /** Needed to refund, and the only proof the charge existed. Never leaves the disk. */
  chargeId?: string;
  refundedAt?: number;
  failure?: string;
}

/**
 * Paid promotion slots, on disk.
 *
 * On disk rather than in memory because the window between taking somebody's money and
 * posting their card spans a restart perfectly happily, and an order lost in that gap is money
 * taken for nothing. It is also the answer to "did you charge me twice", which is not a
 * question worth being unable to answer.
 */
export class Promos {
  private orders: PromoOrder[] = [];

  constructor(private readonly store = STORE) {}

  load(): void {
    if (!existsSync(this.store)) return;
    try {
      this.orders = JSON.parse(readFileSync(this.store, 'utf8')) as PromoOrder[];
      // Said out loud at every boot until somebody deals with it. Both states mean the same
      // thing to the person who paid — they are out of pocket with nothing to show for it —
      // and an unpaid debt that only appears in a JSON file is one nobody ever pays.
      const owed = this.orders.filter((o) => o.state === 'owed' || o.state === 'paid');
      if (owed.length) {
        log.warn(`${owed.length} paid promo(s) were never delivered or refunded — see ${this.store}`);
      }
    } catch (err) {
      log.warn(`could not read promo orders: ${(err as Error).message}`);
    }
  }

  add(order: PromoOrder): void {
    this.orders.push(order);
    this.persist();
  }

  find(id: string): PromoOrder | undefined {
    return this.orders.find((o) => o.id === id);
  }

  /** Mutate through this, so no caller can change an order and forget to write it down. */
  update(order: PromoOrder, patch: Partial<PromoOrder>): void {
    Object.assign(order, patch);
    this.persist();
  }

  /**
   * How many slots have been used in the last 24 hours.
   *
   * Counts what was **posted**, not what was invoiced — an abandoned invoice costs the channel
   * nothing and must not hold a slot hostage. Rolling rather than per calendar day, because a
   * cap that resets at midnight is a cap that permits two days' worth of ads back to back.
   */
  postedSince(now: number, windowMs: number): number {
    return this.orders.filter((o) => o.postedAt !== undefined && now - o.postedAt < windowMs).length;
  }

  /** An open invoice for the same coin from the same person, so a double tap does not double charge. */
  pendingFor(buyerId: string, address: string): PromoOrder | undefined {
    return this.orders.find(
      (o) => o.state === 'invoiced' && o.buyerId === buyerId && o.address.toLowerCase() === address.toLowerCase(),
    );
  }

  list(): PromoOrder[] {
    return [...this.orders];
  }

  private persist(): void {
    // An unpaid invoice from three months ago is not evidence of anything. A paid one always
    // is, so age alone never drops a record that took money.
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    this.orders = this.orders.filter((o) => o.createdAt > cutoff || o.state !== 'invoiced');

    try {
      mkdirSync(dirname(this.store), { recursive: true });
      writeFileSync(this.store, JSON.stringify(this.orders, null, 2));
    } catch (err) {
      log.error('could not write promo orders — an order may be lost', (err as Error).message);
    }
  }
}
