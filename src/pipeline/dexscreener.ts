import type { Stats } from '../types';
import { clip } from '../format/text';
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

/**
 * The pool people are actually trading in.
 *
 * Ranked by traded volume rather than reported depth, because depth can be fiction and volume
 * is much harder to fake into existence. A Meteora pool for PARKIFY advertised $1.07bn of
 * liquidity and a $1.43bn market cap on a coin worth $225k, off **one** transaction in
 * twenty-four hours; the pool people were really using was a pumpswap one with $35k of depth
 * and fourteen thousand trades. Ranking by depth took the fiction.
 *
 * Everything downstream inherits this choice — the price, the market cap printed on the card,
 * the chart we link, and the pool address the entry and the peak are later read back from. So
 * the failure was not cosmetic: that coin would have published at roughly six thousand times
 * its real size. It surfaced only because GeckoTerminal keeps no candles for a pool nobody
 * trades in, which quietly cost 41% of scraped calls their true entry price.
 *
 * Volume falls back to depth when nothing has traded anywhere yet, which is the honest order
 * for a coin minutes old — at that point depth is the only evidence there is.
 */
export function mainPool(pairs: DexPair[]): DexPair | undefined {
  if (!pairs.length) return undefined;
  const traded = pairs.filter((p) => (p.volume?.h24 ?? 0) > 0);
  if (traded.length) return traded.reduce((a, b) => ((b.volume?.h24 ?? 0) > (a.volume?.h24 ?? 0) ? b : a));
  return pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
}

export interface TokenView {
  /** The pool with the real trading in it: what a buyer meets, and the chart worth linking. */
  best: DexPair;
  stats: Stats;
  /** The coin's artwork, if any pool carries a profile for it. */
  imageUrl?: string;
}

/**
 * Collapses every pool holding a token into one view.
 *
 * Liquidity and volume are summed rather than read off the main pool, because market cap
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
 * How long a name or symbol may be before it is cut. Long enough for the real ones —
 * "Official Trump" and its imitators all fit — and short enough that a hundred cards still
 * add up to less than one Telegram message limit.
 */
const TEXT_LIMIT = 48;

/**
 * A name or symbol as the deployer typed it, which is not always as it should be shown.
 *
 * Fartcoin's are `"Fartcoin "` on both fields, and untouched they render the title as
 * `Fartcoin  | FARTCOIN ` and every reply about it as `$FARTCOIN `. Whitespace-only becomes
 * absent, so the card falls back to whichever field is real rather than printing a gap.
 *
 * The rest of this is not tidying. Both fields are chosen by whoever deployed the coin, for the
 * price of a launch, and they end up inside HTML we send to a room of people who are about to
 * buy something. So a symbol is treated as hostile input rather than as a label:
 *
 * - **Angle brackets go.** Render sites escape, and the one that forgets puts a working link
 *   on our own pinned board inside a message everybody reads as ours. Taking them out here
 *   makes the next site to forget merely wrong instead of dangerous — and a `<` that reaches
 *   Telegram unescaped fails the whole send, so the same coin can also silence a milestone.
 * - **Bidi and zero-width controls go.** A right-to-left override reverses everything printed
 *   after it, which is how a string is made to read as something other than what it is. Beside
 *   a contract address is exactly where that must not work.
 * - **Newlines collapse.** These are printed inline. A name containing one rewrites the shape
 *   of the card around it and can forge a line we did not write.
 * - **Length is capped**, on character boundaries. The field is unbounded and a Telegram message
 *   is not, so without this a sufficiently long name is a coin that stops our channel from
 *   posting — and cutting one of its emoji in half would do the same thing for a subtler reason.
 */
export function tokenText(value: string | undefined): string | undefined {
  const cleaned = value
    // Bidi and zero-width controls carry nothing a reader can see, so they simply go.
    ?.replace(/\p{Cf}/gu, '')
    // Newlines and brackets become a gap rather than vanishing: deleting the newline out of
    // "SAFE\nMOON" would print SAFEMOON, which is a different coin and a real one.
    .replace(/[\p{Cc}<>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return clip(cleaned, TEXT_LIMIT);
}

/**
 * Could a pool this deep exist for a coin this size?
 *
 * A pool holds tokens on one side, so the value it can hold is bounded by what the whole coin
 * is worth — counting both sides, at the impossible extreme where every last token sits in one
 * pool, twice that. Three times is slack no honest pool needs.
 *
 * This is not pedantry about a chart. Liquidity is summed across pools and then read by the
 * risk screen, so one pool advertising $1.07bn against a $225k coin does not merely look odd,
 * it carries a coin with $35k of real depth over any floor we could set. The comment on the
 * sum below is right that undercounting is the safe direction — which is exactly why
 * overcounting cannot be left in.
 *
 * With no market cap to compare against there is nothing to test, and the pool is kept: this
 * throws out the impossible, not the merely unknown.
 */
function plausible(pair: DexPair, marketCapUsd: number | undefined): boolean {
  const liquidity = pair.liquidity?.usd;
  if (!marketCapUsd || !liquidity) return true;
  return liquidity <= marketCapUsd * 3;
}

export function aggregate(pairs: DexPair[], tokenAddress: string): TokenView | undefined {
  const q = tokenAddress.toLowerCase();
  const matching = pairs.filter((p) => p.baseToken?.address?.toLowerCase() === q);
  const best = mainPool(matching);
  if (!best) return undefined;

  /**
   * One address, one chain.
   *
   * An EVM address is a hash of the deployer and a nonce, so the same string is routinely a
   * *different token* on another chain — and DexScreener answers the token endpoint by address
   * across all of them. Matching on the address alone therefore sums the liquidity of several
   * unrelated coins into one card and reads the chain off whichever of them traded most.
   *
   * Seen live: one scraped address came back as three coins at once, on base, robinhood and
   * ethereum. Small numbers in that instance, but the direction is the dangerous one — the sum
   * only ever runs high, and the risk screen reads it to decide whether a pool can be exited.
   *
   * The busiest pool decides which chain is meant, which is the same judgement `mainPool`
   * already makes and for the same reason: the coin somebody is asking about is the one with
   * a market, not the one that happens to share its address.
   */
  const own = matching.filter((p) => p.chainId === best.chainId);

  const real = own.filter((p) => plausible(p, best.marketCap ?? best.fdv));
  const liquidityUsd = sum(real.map((p) => p.liquidity?.usd));
  const volumeUsd = sum(real.map((p) => p.volume?.h24));
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
