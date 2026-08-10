import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBase58, holderFacts, isOnCurve, mintFacts } from '../src/pipeline/onchain';

/**
 * The checks a careful buyer runs by hand, and the reason nobody should have to.
 *
 * These become a public claim about whether a coin can be sold, so the tests here are about the
 * two ways such a claim goes wrong: saying a token is clear when we could not actually check,
 * and flagging a healthy token so often that everyone learns to ignore the flag.
 */

/* Real addresses, so the curve maths is checked against the chain rather than against itself. */
const WALLET = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const METADATA_PDA = 'FDZZbyY9XGpL3CNKUZxLk3wFTTQYL3TkDiDzqxrizcPN';
const RAYDIUM_AUTHORITY = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';

type Reply = Record<string, unknown> | 'rate-limited';

/** Answers RPC calls by method name, so a test only states the parts it cares about. */
function chain(replies: Record<string, Reply>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const { method } = JSON.parse(init.body) as { method: string };
      const reply = replies[method];
      if (!reply || reply === 'rate-limited') {
        return { ok: false, status: 429, json: async () => ({}) } as Response;
      }
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: reply }) } as Response;
    }),
  );
}

function mintAccount(over: Record<string, unknown> = {}) {
  return {
    context: { slot: 1 },
    value: {
      owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      data: {
        program: 'spl-token',
        parsed: {
          type: 'mint',
          info: { mintAuthority: null, freezeAuthority: null, supply: '1000', decimals: 5, ...over },
        },
      },
    },
  };
}

/** `getTokenLargestAccounts` plus the owner lookup that says which of them are pools. */
function holders(rows: Array<{ amount: string; owner: string | null }>) {
  return {
    getTokenLargestAccounts: {
      context: { slot: 1 },
      value: rows.map((r, i) => ({ address: `acct${i}`, amount: r.amount })),
    },
    getMultipleAccounts: {
      context: { slot: 1 },
      value: rows.map((r) =>
        r.owner === null
          ? null
          : { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: { parsed: { info: { owner: r.owner } } } },
      ),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('telling a wallet from a pool', () => {
  // The whole holder calculation rests on this one question, so it is checked against addresses
  // whose answer is a matter of public record rather than of our own arithmetic.
  it('knows a key a person could hold from one no one can', () => {
    expect(isOnCurve(WALLET), 'a wallet').toBe(true);
    expect(isOnCurve(BONK), 'a mint is also a keypair').toBe(true);
    expect(isOnCurve(METADATA_PDA), 'a metadata account is derived, not held').toBe(false);
    expect(isOnCurve(RAYDIUM_AUTHORITY), 'an AMM authority is a program address').toBe(false);
  });

  it('refuses anything that is not a 32-byte address', () => {
    expect(isOnCurve('0OIl')).toBe(false); // characters base58 does not contain
    expect(isOnCurve('abc')).toBe(false);
    expect(isOnCurve('')).toBe(false);
  });

  it('keeps the leading zeroes that base58 writes as ones', () => {
    expect(decodeBase58('11111111111111111111111111111111')?.length).toBe(32);
    expect(decodeBase58(BONK)?.length).toBe(32);
    expect(decodeBase58('l0O')).toBeUndefined();
  });
});

describe('reading the mint', () => {
  it('reports a revoked authority as absent and a live one by name', async () => {
    chain({ getAccountInfo: mintAccount({ mintAuthority: WALLET, freezeAuthority: null }) });
    const facts = await mintFacts(BONK);

    expect(facts?.mintAuthority, 'someone can still print supply').toBe(WALLET);
    expect(facts?.freezeAuthority, 'nobody can freeze a seller').toBeUndefined();
  });

  /**
   * A u64 supply does not fit in a JavaScript number and the large-supply memecoins are the
   * entire subject, so this is the difference between every share below being right and being
   * quietly, unfalsifiably wrong.
   */
  it('holds a supply too large for a number without losing digits', async () => {
    chain({ getAccountInfo: mintAccount({ supply: '8799458994895795941' }) });
    const facts = await mintFacts(BONK);

    expect(facts?.supply).toBe(8799458994895795941n);
    expect(facts?.supply.toString(), 'not rounded to ...796000').toBe('8799458994895795941');
  });

  // Silence must not read as a pass anywhere in this file. A mint minted seconds ago is the
  // case that matters, because a brand new coin is the one we are asked about fastest.
  it('says it does not know, rather than nothing, when the account is not there yet', async () => {
    chain({ getAccountInfo: { context: { slot: 1 }, value: null } });
    await expect(mintFacts(BONK)).resolves.toBeUndefined();
  });

  it('says it does not know when the endpoint turns us away', async () => {
    chain({ getAccountInfo: 'rate-limited' });
    await expect(mintFacts(BONK)).resolves.toBeUndefined();
  });
});

describe('reading the holders', () => {
  /**
   * The check this whole module exists for, and the one that is worthless without the pool
   * being taken out: the pool is the largest holder of almost every healthy token, so counting
   * it would flag everything and teach everyone to ignore the flag.
   */
  it('takes the liquidity pool out before calling anyone a whale', async () => {
    chain(
      holders([
        { amount: '600', owner: RAYDIUM_AUTHORITY }, // the pool
        { amount: '300', owner: WALLET }, // an actual holder
        { amount: '100', owner: BONK },
      ]),
    );
    const facts = await holderFacts('mint', 1000n);

    expect(facts?.topShare, 'the pool is not a whale').toBeCloseTo(0.3, 5);
    expect(facts?.poolAccounts).toBe(1);
    expect(facts?.examined).toBe(3);
  });

  it('catches the one dev holding almost all of it', async () => {
    chain(holders([{ amount: '900', owner: WALLET }, { amount: '100', owner: BONK }]));
    const facts = await holderFacts('mint', 1000n);

    expect(facts?.topShare).toBeCloseTo(0.9, 5);
    expect(facts?.top10Share).toBeCloseTo(1, 5);
  });

  // Errs toward flagging. Guessing the other way would let a whale hide behind a failed lookup,
  // and the failure would be invisible because the number would still look reasonable.
  it('counts an owner it could not read as a person, not as a pool', async () => {
    chain(holders([{ amount: '900', owner: null }, { amount: '100', owner: WALLET }]));
    const facts = await holderFacts('mint', 1000n);

    expect(facts?.topShare).toBeCloseTo(0.9, 5);
    expect(facts?.poolAccounts).toBe(0);
  });

  it('says it does not know when the holder call is rate limited', async () => {
    chain({ getTokenLargestAccounts: 'rate-limited' });
    await expect(holderFacts('mint', 1000n)).resolves.toBeUndefined();
  });

  // Reached when every top account is a pool, which is a real state for a freshly seeded token
  // and must not divide by anything or invent a holder.
  it('reports no concentration when every account is a pool', async () => {
    chain(holders([{ amount: '1000', owner: RAYDIUM_AUTHORITY }]));
    const facts = await holderFacts('mint', 1000n);

    expect(facts?.topShare).toBe(0);
    expect(facts?.poolAccounts).toBe(1);
  });

  it('will not divide by a supply of nothing', async () => {
    chain(holders([{ amount: '1', owner: WALLET }]));
    await expect(holderFacts('mint', 0n)).resolves.toBeUndefined();
  });
});
