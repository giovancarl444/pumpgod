import type { AddressKind, Chain, TokenRef } from '../types';
import { chainFromSlug } from './chains';

const EVM = /\b0x[a-fA-F0-9]{40}\b/g;
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SUI = /\b0x[a-fA-F0-9]{64}::[a-zA-Z0-9_]+::[a-zA-Z0-9_]+\b/g;
const TRON = /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/g;
// Deliberately not named `URL` — that would shadow the global constructor used below.
const URL_RE = /https?:\/\/[^\s<>()\[\]"']+/g;

/** Labels a call group puts in front of the token address. Ordered longest-first so
 *  "Contract Address" wins over "Address" and we never truncate the match. */
const TOKEN_LABEL =
  /(?:contract\s*address|token\s*address|mint\s*address|contract|address|token|mint|coin|ca|c\.a)\s*[:\-–—>»]*\s*/gi;
const PAIR_LABEL = /(?:pair\s*address|pair|pool|lp)\s*[:\-–—>»]*\s*/gi;

/**
 * A 32-44 char base58 run is a weak signal on its own — hashes and IDs match too.
 * Real Solana pubkeys are 32 random bytes, so the chance of no digit or no uppercase
 * is ~1e-8. Requiring both removes almost every false positive at no real cost.
 */
function looksLikeSolana(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  return /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

const SOLANA_BLOCKLIST = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** Burn/router/stable addresses that show up in calls but are never the subject. */
const EVM_BLOCKLIST = new Set(
  [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    '0xdead000000000000000042069420694206942069',
  ].map((a) => a.toLowerCase()),
);

interface UrlHit {
  address: string;
  kind: AddressKind;
  chain: Chain;
  /** Chart links point at a pool, token pages point at the token itself. */
  isPair: boolean;
}

function classify(address: string): { kind: AddressKind; chain: Chain } | undefined {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return { kind: 'evm', chain: 'unknown' };
  if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return { kind: 'tron', chain: 'tron' };
  if (looksLikeSolana(address)) return { kind: 'solana', chain: 'solana' };
  return undefined;
}

/** Pull token/pair addresses out of the chart and explorer links pasted into calls. */
export function addressesFromUrls(text: string): UrlHit[] {
  const hits: UrlHit[] = [];
  const urls = text.match(URL_RE) ?? [];

  for (const raw of urls) {
    const url = raw.replace(/[.,;:!]+$/, '');
    let host: string;
    let path: string;
    let query: URLSearchParams;
    try {
      const u = new URL(url);
      host = u.hostname.replace(/^www\./, '');
      path = u.pathname;
      query = u.searchParams;
    } catch {
      continue;
    }

    const segs = path.split('/').filter(Boolean);
    const push = (address: string, chain: Chain, isPair: boolean) => {
      const c = classify(address);
      if (!c) return;
      hits.push({ address, kind: c.kind, chain: chain === 'unknown' ? c.chain : chain, isPair });
    };

    if (host.endsWith('dexscreener.com')) {
      // /{chainSlug}/{pairAddress}  — the path address is the POOL, not the token.
      const slug = segs[0] ? chainFromSlug(segs[0]) : undefined;
      const q = query.get('q');
      if (q) push(q, slug ?? 'unknown', false);
      if (segs.length >= 2 && segs[1]) push(segs[1], slug ?? 'unknown', true);
    } else if (host.endsWith('pump.fun')) {
      // Solana-only launchpad; /coin/{mint} or /{mint}
      const mint = segs[segs.length - 1];
      if (mint) push(mint, 'solana', false);
    } else if (host.endsWith('dextools.io')) {
      const i = segs.indexOf('pair-explorer');
      const slug = segs.find((s) => chainFromSlug(s) !== undefined);
      const chain = slug ? chainFromSlug(slug) ?? 'unknown' : 'unknown';
      if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, chain, true);
    } else if (host.endsWith('birdeye.so')) {
      const i = segs.indexOf('token');
      const chain = chainFromSlug(query.get('chain') ?? '') ?? 'unknown';
      if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, chain, false);
    } else if (host.endsWith('gmgn.ai')) {
      // /{chain}/token/{address}
      const chain = segs[0] ? chainFromSlug(segs[0]) ?? 'unknown' : 'unknown';
      const i = segs.indexOf('token');
      if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, chain, false);
    } else if (host.includes('photon')) {
      const i = segs.indexOf('lp');
      if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, 'solana', true);
    } else if (host.endsWith('bullx.io') || host.endsWith('neo.bullx.io')) {
      const a = query.get('address');
      if (a) push(a, 'unknown', false);
    } else if (host.endsWith('solscan.io') || host.endsWith('solana.fm')) {
      const i = Math.max(segs.indexOf('token'), segs.indexOf('address'));
      if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, 'solana', false);
    } else if (host.endsWith('jup.ag')) {
      const last = segs[segs.length - 1];
      if (last) push(last, 'solana', false);
    } else {
      const explorer: Record<string, Chain> = {
        'etherscan.io': 'ethereum',
        'basescan.org': 'base',
        'bscscan.com': 'bsc',
        'arbiscan.io': 'arbitrum',
        'polygonscan.com': 'polygon',
        'snowtrace.io': 'avalanche',
        'blastscan.io': 'blast',
      };
      const chain = explorer[host];
      if (chain) {
        const i = Math.max(segs.indexOf('token'), segs.indexOf('address'));
        if (i >= 0 && segs[i + 1]) push(segs[i + 1]!, chain, false);
      }
    }
  }
  return hits;
}

function labelledAt(text: string, label: RegExp): Set<string> {
  const found = new Set<string>();
  label.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = label.exec(text)) !== null) {
    // Only the text immediately after the label counts. 64 chars covers the longest
    // address form plus a little slack for backticks and stray whitespace.
    const window = text.slice(m.index + m[0].length, m.index + m[0].length + 80);
    const candidate =
      window.match(/^[`"']?\s*(0x[a-fA-F0-9]{40})/)?.[1] ??
      window.match(/^[`"']?\s*([1-9A-HJ-NP-Za-km-z]{32,44})/)?.[1] ??
      window.match(/^[`"']?\s*(T[1-9A-HJ-NP-Za-km-z]{33})/)?.[1];
    if (candidate && classify(candidate)) found.add(candidate);
  }
  return found;
}

/**
 * Rank every address in a message by how likely it is to be the token being called.
 * Labelled beats a token page beats a bare address beats a chart link's pool address —
 * that ordering is what stops us calling the LP instead of the coin.
 */
export function extractAddresses(text: string): { tokens: TokenRef[]; pairAddress?: string } {
  const urlHits = addressesFromUrls(text);
  const labelledTokens = labelledAt(text, TOKEN_LABEL);
  const labelledPairs = labelledAt(text, PAIR_LABEL);

  // Bare addresses are only meaningful outside URLs, otherwise every chart link
  // double-counts as a bare hit.
  const stripped = text.replace(URL_RE, ' ');
  const bare = new Set<string>();
  for (const re of [EVM, TRON, BASE58]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stripped)) !== null) {
      if (classify(m[0])) bare.add(m[0]);
    }
  }
  for (const m of text.match(SUI) ?? []) bare.add(m);

  const pairAddresses = new Set<string>([
    ...labelledPairs,
    ...urlHits.filter((h) => h.isPair).map((h) => h.address),
  ]);

  const chainHint =
    urlHits.find((h) => h.chain !== 'unknown')?.chain ?? undefined;

  const scored = new Map<string, TokenRef>();
  const consider = (address: string, origin: TokenRef['origin'], confidence: number) => {
    const c = classify(address);
    if (!c) return;
    const lower = address.toLowerCase();
    if (EVM_BLOCKLIST.has(lower) || SOLANA_BLOCKLIST.has(address)) return;

    const urlChain = urlHits.find((h) => h.address === address)?.chain;
    const chain: Chain =
      urlChain && urlChain !== 'unknown'
        ? urlChain
        : c.chain !== 'unknown'
          ? c.chain
          : chainHint ?? 'unknown';

    // A pool address can still be the best we have, but it must never outrank a token.
    const penalised = pairAddresses.has(address) ? confidence * 0.35 : confidence;
    const existing = scored.get(address);
    if (!existing || penalised > existing.confidence) {
      scored.set(address, { address, kind: c.kind, chain, origin, confidence: penalised });
    }
  };

  for (const a of labelledTokens) consider(a, 'labelled', 1);
  for (const h of urlHits) if (!h.isPair) consider(h.address, 'link', 0.75);
  for (const a of bare) consider(a, 'bare', 0.6);
  for (const h of urlHits) if (h.isPair) consider(h.address, 'link', 0.5);

  const tokens = [...scored.values()].sort((a, b) => b.confidence - a.confidence);

  const pair =
    [...pairAddresses].find((p) => p !== tokens[0]?.address) ?? undefined;

  return { tokens, pairAddress: pair };
}
