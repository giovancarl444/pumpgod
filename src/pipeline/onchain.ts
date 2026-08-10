import type { ChainFacts, HolderFacts, MintFacts } from '../types';
import { log } from '../log';

/**
 * What the chain itself says about a token, as opposed to what a price API says about its pool.
 *
 * `risk.ts` answers "can we get out of this" from market data. It cannot answer "can they stop
 * us getting out", because that is not a fact about the pool — it is a fact about the mint, and
 * only the chain has it. These are the checks a careful buyer runs by hand before touching
 * anything, and the whole point of running them here is that nobody should have to.
 *
 * Every check is a fact rather than a judgement: an authority is set or it is not. That matters
 * because these become a public claim, and a claim anyone can reproduce with the same two RPC
 * calls is the only kind worth printing.
 */

/** Solana's own endpoint works and rate-limits hard. Anything real wants a keyed free tier. */
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export interface RpcOptions {
  /** Overridable so a keyed endpoint can be configured without touching call sites. */
  endpoint?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 6_000;

async function rpc<T>(method: string, params: unknown[], options: RpcOptions = {}): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(options.endpoint ?? PUBLIC_RPC, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) {
      // Being turned away is the ordinary answer from the public endpoint, so it is logged at
      // debug rather than treated as an incident. The caller turns it into an explicit
      // "could not check", which is the part that must never look like a pass.
      log.debug(`rpc ${method} returned ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
    if (body.error) {
      // Both branches matter, and only one of them is obvious. `api.mainnet-beta.solana.com`
      // answers `getTokenLargestAccounts` with **HTTP 200** carrying `error.code: 429`, so a
      // client that only checked the status would read a rate limit as a successful lookup
      // returning no holders — a token with no holders being, of course, a clean bill of health.
      log.debug(`rpc ${method} failed: ${body.error.message ?? 'no reason given'}`);
      return undefined;
    }
    return body.result;
  } catch (err) {
    if ((err as Error).name !== 'AbortError') log.debug(`rpc ${method} failed`, (err as Error).message);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

interface ParsedAccount<T> {
  value: { data: { parsed: { info: T; type?: string }; program?: string }; owner: string } | null;
}

/**
 * Reads the mint. `undefined` means we could not find out, which is never the same as clear.
 *
 * A token minted seconds ago is the case worth naming: the account exists on chain before the
 * indexers have caught up with it, and a brand new coin is exactly the kind we are asked about
 * fastest. Silence here has to mean "ask again", not "no".
 */
export async function mintFacts(mint: string, options: RpcOptions = {}): Promise<MintFacts | undefined> {
  // Every account-reading method wraps its payload in `{ context, value }`, so the account
  // itself is one level further down than the method name suggests.
  const res = await rpc<
    ParsedAccount<{
      mintAuthority: string | null;
      freezeAuthority: string | null;
      supply: string;
      decimals: number;
    }>
  >('getAccountInfo', [mint, { encoding: 'jsonParsed' }], options);

  // A `null` value is an address that holds nothing — a typo, or a mint that does not exist.
  const info = res?.value?.data?.parsed?.info;
  if (!info || typeof info.supply !== 'string') return undefined;

  return {
    mintAuthority: info.mintAuthority ?? undefined,
    freezeAuthority: info.freezeAuthority ?? undefined,
    supply: BigInt(info.supply),
    decimals: info.decimals,
  };
}

/**
 * How concentrated the holders are, with the pools removed.
 *
 * Removing them is not a refinement, it is the difference between the number meaning anything
 * and meaning nothing. The largest holder of a healthy token is almost always its liquidity
 * pool, so a naive reading of "top holder owns 43%" flags every good coin on the chain and
 * teaches everyone to ignore the check.
 *
 * A pool is told apart from a person by asking whether its owner address lies on the ed25519
 * curve. Every address a human can sign for is a public key and is on the curve; every address
 * a program controls is derived precisely so that it is not. That is a property of how Solana
 * generates the two, so unlike a list of known AMM addresses it cannot go stale.
 */
export async function holderFacts(
  mint: string,
  supply: bigint,
  options: RpcOptions = {},
): Promise<HolderFacts | undefined> {
  if (supply <= 0n) return undefined;

  const largest = await rpc<{ value: Array<{ address: string; amount: string }> }>(
    'getTokenLargestAccounts',
    [mint],
    options,
  );
  const accounts = largest?.value;
  if (!accounts?.length) return undefined;

  // One extra round trip for all twenty owners rather than twenty round trips.
  const owners = await rpc<{ value: Array<ParsedAccount<{ owner: string }>['value']> }>(
    'getMultipleAccounts',
    [accounts.map((a) => a.address), { encoding: 'jsonParsed' }],
    options,
  );
  if (!owners?.value) return undefined;

  const held: bigint[] = [];
  let poolAccounts = 0;
  accounts.forEach((account, i) => {
    const owner = owners.value[i]?.data?.parsed?.info?.owner;
    // An owner we could not read is treated as a person: it counts toward concentration and so
    // errs toward flagging. Guessing the other way would hide a whale behind a failed lookup.
    if (owner && !isOnCurve(owner)) {
      poolAccounts += 1;
      return;
    }
    held.push(BigInt(account.amount));
  });

  if (!held.length) return { topShare: 0, top10Share: 0, poolAccounts, examined: accounts.length };

  held.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  return {
    topShare: share(held[0]!, supply),
    top10Share: share(
      held.slice(0, 10).reduce((sum, n) => sum + n, 0n),
      supply,
    ),
    poolAccounts,
    examined: accounts.length,
  };
}

/**
 * Both questions, asked together, for a caller that just wants to know about a token.
 *
 * The holder call needs the supply, so the two cannot be issued in parallel — and it is the
 * call the public endpoint refuses most often, which is exactly why its answer is a separate
 * field. A mint whose authorities are readable and whose holders are not is a real and common
 * state, and it has to be reportable as such rather than collapsing into a single verdict.
 */
export async function chainFacts(mint: string, options: RpcOptions = {}): Promise<ChainFacts> {
  const facts = await mintFacts(mint, options);
  if (!facts) return {};
  return { mint: facts, holders: await holderFacts(mint, facts.supply, options) };
}

/**
 * A fraction, computed without ever putting a u64 into a double.
 *
 * Scaling by a million first keeps six digits of precision through the division while both
 * sides are still exact integers, and only the small result becomes a number.
 */
function share(amount: bigint, supply: bigint): number {
  return Number((amount * 1_000_000n) / supply) / 1_000_000;
}

/* ────────────────────────────── address maths ────────────────────────────── */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes. Returns `undefined` for anything that is not a valid encoding. */
export function decodeBase58(text: string): Uint8Array | undefined {
  let n = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) return undefined;
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Every leading '1' encodes a leading zero byte, which the loop above cannot recover.
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const P = 2n ** 255n - 19n;
const D = mod(-121665n * inverse(121666n));

function mod(n: bigint): bigint {
  const r = n % P;
  return r < 0n ? r + P : r;
}

function inverse(n: bigint): bigint {
  return power(mod(n), P - 2n);
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod(result * b);
    b = mod(b * b);
    e >>= 1n;
  }
  return result;
}

/**
 * Whether an address is a real ed25519 public key, which is to say whether a person could hold
 * its private key.
 *
 * Solana derives program addresses by hashing until the result is *not* a valid curve point,
 * exactly so that nobody can ever sign for one. So this single question separates wallets from
 * pools, vaults and every other account a protocol controls, and it stays true without anyone
 * maintaining a list.
 */
export function isOnCurve(address: string): boolean {
  const bytes = decodeBase58(address);
  if (!bytes || bytes.length !== 32) return false;

  // Little-endian, with the top bit holding the sign of x rather than part of y.
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;

  // Recover x from the curve equation and check a solution actually exists.
  const yy = mod(y * y);
  const u = mod(yy - 1n);
  const v = mod(D * yy + 1n);
  const xx = mod(u * inverse(v));

  let x = power(xx, (P + 3n) / 8n);
  if (mod(x * x - xx) !== 0n) x = mod(x * power(2n, (P - 1n) / 4n));
  return mod(x * x - xx) === 0n;
}
