import type { Chain, ParsedCall } from '../types';
import { chainFromSlug } from '../parse/chains';
import { log } from '../log';

interface DexPair {
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  baseToken?: { name?: string; symbol?: string };
  pairCreatedAt?: number;
}

/**
 * Enrichment never gates a call. We publish on what the source gave us and fold this in
 * afterwards, because a coin's first thirty seconds are worth more than a tidy message.
 */
export async function enrich(call: ParsedCall, timeoutMs: number): Promise<Partial<ParsedCall> | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${call.token.address}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return undefined;

    const body = (await res.json()) as { pairs?: DexPair[] };
    const pairs = body.pairs ?? [];
    if (!pairs.length) return undefined;

    // Deepest liquidity is the pool people will actually trade against.
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));

    const chain: Chain = (best.chainId && chainFromSlug(best.chainId)) || call.token.chain;

    return {
      token: { ...call.token, chain },
      pairAddress: best.pairAddress ?? call.pairAddress,
      name: best.baseToken?.name ?? call.name,
      ticker: best.baseToken?.symbol?.toUpperCase() ?? call.ticker,
      stats: {
        ...call.stats,
        marketCapUsd: best.marketCap ?? best.fdv ?? call.stats.marketCapUsd,
        liquidityUsd: best.liquidity?.usd ?? call.stats.liquidityUsd,
        volumeUsd: best.volume?.h24 ?? call.stats.volumeUsd,
        priceUsd: best.priceUsd ? Number(best.priceUsd) : call.stats.priceUsd,
        ageText: best.pairCreatedAt ? age(best.pairCreatedAt) : call.stats.ageText,
      },
    };
  } catch (err) {
    if ((err as Error).name !== 'AbortError') log.debug('enrich failed', (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function age(createdAtMs: number): string {
  const mins = Math.max(1, Math.floor((Date.now() - createdAtMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
