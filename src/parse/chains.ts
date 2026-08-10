import type { AddressKind, Chain } from '../types';

/**
 * What an address on each chain looks like. Lets a caller rule a chain out from the address
 * shape alone, before spending a network round trip confirming what base58 already proved.
 */
export const CHAIN_KIND: Record<Chain, AddressKind | undefined> = {
  solana: 'solana',
  tron: 'tron',
  sui: 'sui',
  ton: 'ton',
  ethereum: 'evm',
  base: 'evm',
  bsc: 'evm',
  arbitrum: 'evm',
  polygon: 'evm',
  avalanche: 'evm',
  blast: 'evm',
  hyperliquid: 'evm',
  robinhood: 'evm',
  unknown: undefined,
};

/**
 * Slugs used by DexScreener/DexTools/GMGN in chart URLs, mapped onto our chain ids.
 * The URL slug is the single most reliable chain signal in a call message.
 */
const SLUGS: Record<string, Chain> = {
  solana: 'solana',
  sol: 'solana',
  ethereum: 'ethereum',
  eth: 'ethereum',
  ether: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  binance: 'bsc',
  bnb: 'bsc',
  arbitrum: 'arbitrum',
  arb: 'arbitrum',
  polygon: 'polygon',
  matic: 'polygon',
  avalanche: 'avalanche',
  avax: 'avalanche',
  blast: 'blast',
  sui: 'sui',
  tron: 'tron',
  ton: 'ton',
  hyperliquid: 'hyperliquid',
  hyperevm: 'hyperliquid',
  robinhood: 'robinhood',
};

export function chainFromSlug(slug: string): Chain | undefined {
  return SLUGS[slug.trim().toLowerCase()];
}

/**
 * Last-resort inference from prose like "🌐 Robinhood Chain" or "on Base".
 * Only consulted when no chart link gave us a slug.
 */
export function chainFromText(text: string): Chain | undefined {
  const lower = text.toLowerCase();
  for (const [slug, chain] of Object.entries(SLUGS)) {
    // Require a word boundary so "sol" does not match "solid" and "arb" not "arbitrage".
    if (new RegExp(`\\b${slug}\\b`).test(lower)) return chain;
  }
  return undefined;
}

const EXPLORERS: Record<Chain, (a: string) => string> = {
  solana: (a) => `https://solscan.io/token/${a}`,
  ethereum: (a) => `https://etherscan.io/token/${a}`,
  base: (a) => `https://basescan.org/token/${a}`,
  bsc: (a) => `https://bscscan.com/token/${a}`,
  arbitrum: (a) => `https://arbiscan.io/token/${a}`,
  polygon: (a) => `https://polygonscan.com/token/${a}`,
  avalanche: (a) => `https://snowtrace.io/token/${a}`,
  blast: (a) => `https://blastscan.io/token/${a}`,
  sui: (a) => `https://suiscan.xyz/mainnet/coin/${a}`,
  tron: (a) => `https://tronscan.org/#/token20/${a}`,
  ton: (a) => `https://tonviewer.com/${a}`,
  hyperliquid: (a) => `https://hyperevmscan.io/token/${a}`,
  robinhood: (a) => `https://dexscreener.com/robinhood/${a}`,
  unknown: (a) => `https://dexscreener.com/search?q=${a}`,
};

export function explorerUrl(chain: Chain, address: string): string {
  return EXPLORERS[chain](address);
}

/**
 * `dexscreener.com/{chain}/{pair}` is the canonical form — it is what their own API hands
 * back as a pair's `url`. It loads the chart directly, where a search link costs the reader
 * a results page and a second click. Falling back to search whenever the chain is unknown or
 * no pool address was parsed, because a wrong direct link is a 404 and search always works.
 */
export function dexScreenerUrl(chain: Chain, pairAddress: string | undefined, tokenAddress: string): string {
  if (pairAddress && chain !== 'unknown') return `https://dexscreener.com/${chain}/${pairAddress}`;
  return `https://dexscreener.com/search?q=${tokenAddress}`;
}

/**
 * Deep link into a trading terminal so the channel can act in one tap. Templated rather than
 * hardcoded because the right terminal differs by chain and by who is running the channel —
 * and because a referral-bearing link belongs in `.env`, not committed to a public repo.
 */
/** Whether a real terminal is configured for this chain, so a card can leave the Buy link
 *  out rather than show a DexScreener search wearing a Buy label. */
export function hasTradeUrl(chain: Chain, templates: { sol: string; evm: string }): boolean {
  return Boolean(chain === 'solana' ? templates.sol : templates.evm);
}

export function tradeUrl(chain: Chain, address: string, templates: { sol: string; evm: string }): string {
  const template = chain === 'solana' ? templates.sol : templates.evm;
  if (!template) return `https://dexscreener.com/search?q=${address}`;
  // Addresses are base58 or hex by the time they get here, so encoding is a no-op that
  // stays correct if the address rules ever loosen.
  return template.replace('{address}', encodeURIComponent(address)).replace('{chain}', chain);
}

export function chainLabel(chain: Chain): string {
  if (chain === 'bsc') return 'BSC';
  if (chain === 'ton') return 'TON';
  if (chain === 'unknown') return 'Unknown';
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}
