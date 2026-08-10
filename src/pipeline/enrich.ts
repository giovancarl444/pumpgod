import type { Chain, ParsedCall } from '../types';
import { chainFromSlug } from '../parse/chains';
import { aggregate, pairsForToken, tokenText } from './dexscreener';

/**
 * Enrichment never gates a relayed call. We publish on what the source gave us and fold this
 * in afterwards, because a coin's first thirty seconds are worth more than a tidy message.
 */
export async function enrich(call: ParsedCall, timeoutMs: number): Promise<Partial<ParsedCall> | undefined> {
  const pairs = await pairsForToken(call.token.address, timeoutMs);
  const view = pairs && aggregate(pairs, call.token.address);
  if (!view) return undefined;

  const { best, stats } = view;
  const chain: Chain = (best.chainId && chainFromSlug(best.chainId)) || call.token.chain;

  return {
    token: { ...call.token, chain },
    pairAddress: best.pairAddress ?? call.pairAddress,
    name: tokenText(best.baseToken?.name) ?? call.name,
    ticker: tokenText(best.baseToken?.symbol)?.toUpperCase() ?? call.ticker,
    imageUrl: view.imageUrl ?? call.imageUrl,
    // The market's numbers replace the source's claim outright rather than filling gaps in
    // it — a stat the source got wrong is worse than one it never gave.
    stats: { ...call.stats, ...stats },
  };
}
