import type { Chain } from '../types';

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

export function dexScreenerUrl(address: string): string {
  return `https://dexscreener.com/search?q=${address}`;
}

/** Deep link into a trading bot/terminal, so the channel can act in one tap. */
export function tradeUrl(chain: Chain, address: string): string {
  if (chain === 'solana') return `https://axiom.trade/t/${address}`;
  return `https://dexscreener.com/search?q=${address}`;
}

export function chainLabel(chain: Chain): string {
  if (chain === 'bsc') return 'BSC';
  if (chain === 'ton') return 'TON';
  if (chain === 'unknown') return 'Unknown';
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}
