import type { Chain, ParsedCall, Source, TokenRef } from '../types';
import { classifyAddress, extractAddresses } from '../parse/addresses';
import { CHAIN_KIND, chainFromSlug } from '../parse/chains';
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
  commanded: true,
};

export type ManualOutcome =
  | { ok: true; call: ParsedCall; query: string }
  | { ok: false; reason: string };

/**
 * `/signal <address>` — the one command that publishes a coin of our own. `call` works too,
 * and Telegram's `/signal@thebot` suffix is tolerated so tapping the command from a group's
 * autocomplete does the same thing as typing it.
 *
 * The command word is required rather than treating any pasted address as a call, because
 * the war room is also where we talk about coins — and a discussion that publishes itself is
 * a footgun with no undo.
 */
export function parseCommand(text: string): string | undefined {
  const match = /^\s*\/?(?:signal|call)(?:@\w+)?\b[\s:]*/i.exec(text);
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
 *
 * `chains` restricts what we are willing to call. Passing it here as well as at the router
 * means a rejected paste gets told why, instead of being silently dropped.
 */
export async function resolveManualCall(
  input: string,
  timeoutMs: number,
  chains?: Chain[],
): Promise<ManualOutcome> {
  const query = addressIn(input);
  if (!query) {
    return { ok: false, reason: 'no contract address in that — paste an address or a chart link' };
  }

  // An address's own shape already rules chains in or out — base58 is never an EVM contract.
  // Checking it here means the common wrong paste answers instantly instead of after a
  // round trip to an API that was never going to have it.
  const kind = classifyAddress(query)?.kind;
  if (kind && chains?.length && !chains.some((c) => CHAIN_KIND[c] === kind)) {
    return { ok: false, reason: `that is ${kind === 'evm' ? 'an EVM' : `a ${kind}`} address — we are only calling ${chains.join('/')} right now` };
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

  if (chains?.length && !chains.includes(token.chain)) {
    return {
      ok: false,
      reason: `${short(address)} is on ${token.chain}, and we are only calling ${chains.join('/')} right now`,
    };
  }

  return {
    ok: true,
    query,
    call: {
      token,
      pairAddress: best.pairAddress,
      name: best.baseToken?.name,
      ticker: best.baseToken?.symbol?.toUpperCase(),
      stats,
      imageUrl: view.imageUrl,
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
