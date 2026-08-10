import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../config';
import type { Chain, Signal } from '../types';
import { log } from '../log';

const STORE = resolve(ROOT, 'data/tracked.json');

/** DexScreener accepts up to 30 comma-separated addresses per request. */
const BATCH = 30;

/** After a day the outcome is decided; polling longer just burns quota. */
const RETIRE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Below this, the pool is gone in any practical sense. */
const RUG_LIQUIDITY_USD = 500;

export type Outcome = 'called' | 'staged' | 'shadow' | 'dry-run';

const RANK: Record<Outcome, number> = { shadow: 0, 'dry-run': 1, staged: 2, called: 3 };

export interface TrackedCall {
  id: string;
  sourceId: string;
  outcome: Outcome;
  chain: Chain;
  address: string;
  ticker?: string;
  name?: string;
  calledAt: number;
  entryPriceUsd?: number;
  entryMcUsd?: number;
  athPriceUsd?: number;
  athMcUsd?: number;
  athAt?: number;
  lastPriceUsd?: number;
  lastMcUsd?: number;
  lastCheckedAt?: number;
  timeTo2xSec?: number;
  timeTo5xSec?: number;
  timeTo10xSec?: number;
  rugged?: boolean;
  retired?: boolean;
}

interface DexPair {
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

function key(chain: Chain, address: string): string {
  return chain === 'solana' ? `${chain}:${address}` : `${chain}:${address.toLowerCase()}`;
}

export interface Quote {
  priceUsd?: number;
  mcUsd?: number;
  liquidityUsd?: number;
}

/**
 * Folds one price observation into a tracked call. Pure so the milestone and peak logic
 * can be tested directly — these numbers decide which sources we keep, so being able to
 * assert on them matters more than the plumbing around them.
 */
export function applyQuote(call: TrackedCall, quote: Quote, now: number): void {
  const { priceUsd: price, mcUsd: mc, liquidityUsd } = quote;

  call.lastCheckedAt = now;
  if (mc !== undefined) call.lastMcUsd = mc;

  // Liquidity can vanish while the last quoted price still looks fine, so this is checked
  // before the price guard rather than after it.
  if (liquidityUsd !== undefined && liquidityUsd < RUG_LIQUIDITY_USD) call.rugged = true;

  if (price === undefined || !Number.isFinite(price) || price <= 0) return;
  call.lastPriceUsd = price;

  // A source's quoted market cap is usually rounded and often stale, so the first real
  // observation is a truer entry than whatever the message claimed.
  if (call.entryPriceUsd === undefined) {
    call.entryPriceUsd = price;
    if (mc !== undefined) call.entryMcUsd = mc;
  }

  if (call.athPriceUsd === undefined || price > call.athPriceUsd) {
    call.athPriceUsd = price;
    call.athMcUsd = mc ?? call.athMcUsd;
    call.athAt = now;
  }

  const multiple = price / call.entryPriceUsd;
  const elapsed = Math.round((now - call.calledAt) / 1000);
  if (multiple >= 2 && call.timeTo2xSec === undefined) call.timeTo2xSec = elapsed;
  if (multiple >= 5 && call.timeTo5xSec === undefined) call.timeTo5xSec = elapsed;
  if (multiple >= 10 && call.timeTo10xSec === undefined) call.timeTo10xSec = elapsed;
}

/**
 * Records what happened to every call after we saw it. This is the only honest answer to
 * "is this source worth following" — and it is also the raw material for phase 3's recap
 * videos, which need entry price, peak, and how long the run took.
 *
 * Shadow calls are tracked too. That is the entire point of shadow mode: find out what a
 * group would have made us before trusting it with anything.
 */
export class Tracker {
  private readonly calls = new Map<string, TrackedCall>();
  private dirty = false;
  private timer?: NodeJS.Timeout;

  load(): void {
    if (!existsSync(STORE)) return;
    try {
      const raw = JSON.parse(readFileSync(STORE, 'utf8')) as TrackedCall[];
      for (const c of raw) this.calls.set(key(c.chain, c.address), c);
      log.debug(`loaded ${this.calls.size} tracked calls`);
    } catch (err) {
      log.warn(`could not read tracked calls: ${(err as Error).message}`);
    }
  }

  /** Called from the router. Cheap and synchronous — the first price fetch is deferred. */
  track(signal: Signal, outcome: Outcome): void {
    const k = key(signal.call.token.chain, signal.call.token.address);

    // A call typically arrives as `staged` and is promoted to `called` on approval. Keep
    // the original entry price — that is where we would actually have bought — but record
    // the strongest outcome it reached.
    const existing = this.calls.get(k);
    if (existing) {
      if (RANK[outcome] > RANK[existing.outcome]) {
        existing.outcome = outcome;
        this.dirty = true;
      }
      return;
    }

    this.calls.set(k, {
      id: signal.id,
      sourceId: signal.source.id,
      outcome,
      chain: signal.call.token.chain,
      address: signal.call.token.address,
      ticker: signal.call.ticker,
      name: signal.call.name,
      calledAt: Date.now(),
      entryMcUsd: signal.call.stats.marketCapUsd,
      entryPriceUsd: signal.call.stats.priceUsd,
    });
    this.dirty = true;
  }

  start(intervalMs: number): void {
    this.timer = setInterval(() => void this.poll(), intervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.persist();
  }

  private active(): TrackedCall[] {
    const now = Date.now();
    const out: TrackedCall[] = [];
    for (const c of this.calls.values()) {
      if (c.retired) continue;
      if (now - c.calledAt > RETIRE_AFTER_MS) {
        c.retired = true;
        this.dirty = true;
        continue;
      }
      out.push(c);
    }
    return out;
  }

  private async poll(): Promise<void> {
    const active = this.active();
    if (!active.length) return;

    for (let i = 0; i < active.length; i += BATCH) {
      const batch = active.slice(i, i + BATCH);
      try {
        const res = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${batch.map((c) => c.address).join(',')}`,
          { headers: { accept: 'application/json' } },
        );
        if (!res.ok) continue;

        const body = (await res.json()) as { pairs?: DexPair[] };
        const best = new Map<string, DexPair>();
        for (const pair of body.pairs ?? []) {
          const addr = pair.baseToken?.address;
          if (!addr) continue;
          const k = addr.toLowerCase();
          const current = best.get(k);
          if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(k, pair);
        }

        for (const call of batch) {
          const pair = best.get(call.address.toLowerCase());
          if (pair) this.apply(call, pair);
        }
      } catch (err) {
        log.debug(`tracker poll failed: ${(err as Error).message}`);
      }
    }

    this.persist();
  }

  private apply(call: TrackedCall, pair: DexPair): void {
    applyQuote(
      call,
      {
        priceUsd: pair.priceUsd ? Number(pair.priceUsd) : undefined,
        mcUsd: pair.marketCap ?? pair.fdv,
        liquidityUsd: pair.liquidity?.usd,
      },
      Date.now(),
    );
    this.dirty = true;
  }

  persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(resolve(ROOT, 'data'), { recursive: true });
      writeFileSync(STORE, JSON.stringify([...this.calls.values()], null, 2));
    } catch (err) {
      log.warn(`could not persist tracked calls: ${(err as Error).message}`);
    }
  }

  static read(): TrackedCall[] {
    if (!existsSync(STORE)) return [];
    return JSON.parse(readFileSync(STORE, 'utf8')) as TrackedCall[];
  }

  get size(): number {
    return this.calls.size;
  }
}
