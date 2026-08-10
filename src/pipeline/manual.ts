import type { Chain, ParsedCall, Source, TokenRef } from '../types';
import { classifyAddress, extractAddresses } from '../parse/addresses';
import { chainFromSlug } from '../parse/chains';
import { aggregate, pairsForToken, search, type TokenView } from './dexscreener';

/**
 * Our own calls are attributed like any other source, so `npm run scorecard` answers the
 * question that matters once we are picking coins ourselves rather than only relaying:
 * are we better than the groups we follow?
 */
export const MANUAL_SOURCE: Source = {
  id: 'manual',
  label: 'PUMPGOD',
  mode: 'auto',
  enabled: true,
};

export type ManualOutcome =
  | { ok: true; call: ParsedCall; query: string }
  | { ok: false; reason: string };

/**
 * `call <address>` typed in the war room. The command word is required rather than treating
 * any pasted address as a call, because the war room is also where we talk about coins —
 * and a discussion that publishes itself is a footgun with no undo.
 */
export function parseCommand(text: string): string | undefined {
  const match = /^\s*\/?call\b[\s:]*/i.exec(text);
  if (!match) return undefined;
  return text.slice(match[0].length).trim() || undefined;
}

/**
 * Turns whatever was pasted — a bare address, a chart link, a pump.fun URL — into a call
 * carrying live market data.
 *
 * This resolves *before* publishing, which is the opposite of the relay path, for two
 * reasons. Relaying races another group that has already posted, so the round trip is the
 * difference between first and second; a call we make ourselves is racing nobody. And an
 * address on its own has no numbers attached, so the tradability screen would have nothing
 * to read and would pass everything — the one guarantee worth keeping.
 */
export async function resolveManualCall(input: string, timeoutMs: number): Promise<ManualOutcome> {
  const query = addressIn(input);
  if (!query) {
    return { ok: false, reason: 'no contract address in that — paste an address or a chart link' };
  }

  const resolved = await asToken(query, timeoutMs);
  if (resolved === undefined) return { ok: false, reason: 'DexScreener did not answer in time — try again' };
  if (!resolved) {
    // No indexed pool means nothing to buy, which the screen would reject anyway. Real
    // launches are indexed within seconds, so this is a wrong address far more often than
    // an early one.
    return { ok: false, reason: `no pool found for ${short(query)} — nothing to trade against yet` };
  }

  const { view, address } = resolved;
  const { best, stats } = view;

  const token: TokenRef = {
    address,
    kind: classifyAddress(address)?.kind ?? 'evm',
    chain: (best.chainId && chainFromSlug(best.chainId)) || 'unknown',
    // A human typed this one out and the market confirmed it resolves to a real pool. There
    // is no stronger provenance available.
    origin: 'labelled',
    confidence: 1,
  };

  return {
    ok: true,
    query,
    call: {
      token,
      pairAddress: best.pairAddress,
      name: best.baseToken?.name,
      ticker: best.baseToken?.symbol?.toUpperCase(),
      stats,
      candidates: [token],
    },
  };
}

/**
 * `undefined` means the lookup failed, `null` means it succeeded and the token is not
 * listed — a distinction worth keeping, because one is worth retrying and the other is not.
 */
async function asToken(
  query: string,
  timeoutMs: number,
): Promise<{ view: TokenView; address: string } | null | undefined> {
  // The token endpoint is authoritative and answers the common case in one hop.
  const direct = await pairsForToken(query, timeoutMs);
  if (direct === undefined) return undefined;
  const view = aggregate(direct, query);
  if (view) return { view, address: query };

  // Nothing matched, so this was probably a chart link, which carries the pool address
  // rather than the token. Search resolves pools; then re-read the token properly so the
  // aggregate covers every pool rather than just the one that was linked.
  const found = await search(query, timeoutMs);
  if (found === undefined) return undefined;
  const pool = found.find((p) => p.pairAddress?.toLowerCase() === query.toLowerCase());
  const address = pool?.baseToken?.address;
  if (!address) return null;

  const pairs = await pairsForToken(address, timeoutMs);
  if (pairs === undefined) return undefined;
  const full = aggregate(pairs, address);
  return full ? { view: full, address } : null;
}

/** Reuses the message parser, so every chart-link shape it already understands works here. */
function addressIn(input: string): string | undefined {
  return extractAddresses(input).tokens[0]?.address;
}

function short(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
