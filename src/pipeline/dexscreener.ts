import type { Stats } from '../types';
import { log } from '../log';

export interface DexPair {
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  baseToken?: { address?: string; name?: string; symbol?: string };
  pairCreatedAt?: number;
  /** Present once DexScreener has indexed the token's profile. Absent on very new launches. */
  info?: { imageUrl?: string };
}

const BASE = 'https://api.dexscreener.com/latest/dex';

async function get(url: string, timeoutMs: number): Promise<DexPair[] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { pairs?: DexPair[] | null };
    return body.pairs ?? [];
  } catch (err) {
    if ((err as Error).name !== 'AbortError') log.debug('dexscreener failed', (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Every pool holding a given token. */
export function pairsForToken(address: string, timeoutMs: number): Promise<DexPair[] | undefined> {
  return get(`${BASE}/tokens/${encodeURIComponent(address)}`, timeoutMs);
}

/**
 * Free-text lookup. Unlike the token endpoint this also resolves a *pool* address, which is
 * what a pasted chart link carries — but it matches loosely, so callers must confirm the
 * address rather than trusting the ranking. A Solana mint really does come back with pools
 * on other chains that happen to share the string.
 */
export function search(query: string, timeoutMs: number): Promise<DexPair[] | undefined> {
  return get(`${BASE}/search?q=${encodeURIComponent(query)}`, timeoutMs);
}

/** Deepest liquidity is the pool people will actually trade against. */
export function deepest(pairs: DexPair[]): DexPair | undefined {
  if (!pairs.length) return undefined;
  return pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
}

export interface TokenView {
  /** Deepest pool: what a buyer actually trades against, and the chart worth linking to. */
  best: DexPair;
  stats: Stats;
  /** The coin's artwork, if any pool carries a profile for it. */
  imageUrl?: string;
}

/**
 * Collapses every pool holding a token into one view.
 *
 * Liquidity and volume are summed rather than read off the deepest pool, because market cap
 * is a whole-token number — comparing it against a single pool reads a token whose depth is
 * spread across several as unbacked, and the screen would hold back a perfectly tradable
 * call. DexScreener caps the pool list, so a sum can still undercount; that direction is the
 * safe one, since undercounting liquidity holds a call back rather than publishing a rug.
 */
/**
 * Asks DexScreener's CDN for a still frame rather than whatever the logo was uploaded as.
 *
 * `format=auto` on a token whose profile is an animated GIF returns the animation — 3.2MB on
 * the one that prompted this. Telegram does not accept a GIF or a WebP as a photo, so that
 * call would spend seconds uploading bytes that were always going to be rejected and then
 * publish as plain text. `format=png` returns the same image flattened, at 70KB.
 *
 * Only rewritten when the URL already speaks that query language; a plain `.png` link is left
 * exactly as it is.
 */
export function stillImage(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('format')) return url;
    parsed.searchParams.set('format', 'png');
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * A name or symbol as the deployer typed it, which is not always as it should be shown.
 * Fartcoin's are `"Fartcoin "` on both fields, and untouched they render the title as
 * `Fartcoin  | FARTCOIN ` and every reply about it as `$FARTCOIN `. Whitespace-only becomes
 * absent, so the card falls back to whichever field is real rather than printing a gap.
 */
export function tokenText(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export function aggregate(pairs: DexPair[], tokenAddress: string): TokenView | undefined {
  const q = tokenAddress.toLowerCase();
  const own = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === q);
  const best = deepest(own);
  if (!best) return undefined;

  const liquidityUsd = sum(own.map((p) => p.liquidity?.usd));
  const volumeUsd = sum(own.map((p) => p.volume?.h24));
  // Age is when the coin first had a market, not when its busiest pool opened — a migrated
  // launch keeps its original bonding-curve pool, and that is the honest birth date.
  const created = own.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === 'number');

  return {
    best,
    // Read across every pool rather than off `best`: the profile hangs off the token, but
    // DexScreener only attaches it to the pools it has indexed, which need not be the deepest.
    imageUrl: stillImage(own.map((p) => p.info?.imageUrl).find((url): url is string => Boolean(url))),
    stats: {
      marketCapUsd: best.marketCap ?? best.fdv,
      liquidityUsd,
      volumeUsd,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : undefined,
      ageText: created.length ? ageText(Math.min(...created)) : undefined,
    },
  };
}

function sum(values: Array<number | undefined>): number | undefined {
  const known = values.filter((v): v is number => typeof v === 'number');
  return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
}

export function ageText(createdAtMs: number): string {
  const mins = Math.max(1, Math.floor((Date.now() - createdAtMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
