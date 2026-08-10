import { describe, expect, it } from 'vitest';
import { assess } from '../src/pipeline/risk';
import type { ParsedCall, Stats } from '../src/types';

function call(stats: Stats, confidence = 1): ParsedCall {
  return {
    token: {
      address: '0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
      kind: 'evm',
      chain: 'base',
      origin: confidence === 1 ? 'labelled' : 'link',
      confidence,
    },
    stats,
    candidates: [],
  };
}

const codes = (c: ParsedCall, claimed?: number) => assess(c, claimed).flags.map((f) => f.code);

describe('assess', () => {
  it('passes a healthy call — this is the sample message pumpgod was built around', () => {
    const read = assess(call({ marketCapUsd: 36_270, liquidityUsd: 16_910, volumeUsd: 26_410 }));
    expect(read.level).toBe('clear');
    expect(read.flags).toHaveLength(0);
  });

  it('flags a pool too thin to exit', () => {
    const read = assess(call({ marketCapUsd: 50_000, liquidityUsd: 900, volumeUsd: 5_000 }));
    expect(read.level).toBe('danger');
    expect(read.flags[0]!.code).toBe('thin');
  });

  it('calls a drained pool dead rather than merely thin', () => {
    expect(codes(call({ liquidityUsd: 120 }))).toEqual(['dead']);
  });

  it('flags a price standing on almost no liquidity', () => {
    // $2M market cap held up by a $9K pool: the chart is real, the exit is not.
    const read = assess(call({ marketCapUsd: 2_000_000, liquidityUsd: 9_000 }));
    expect(read.level).toBe('danger');
    expect(read.flags.map((f) => f.code)).toContain('ratio');
  });

  it('does not repeat itself when a pool is both thin and badly backed', () => {
    // The thin-pool flag already makes the point; a ratio on a $900 pool adds nothing.
    expect(codes(call({ marketCapUsd: 900_000, liquidityUsd: 900 }))).toEqual(['thin']);
  });

  /**
   * The ratio is a launch-shape heuristic: it decays as a token matures, so on a deep pool it
   * reports age rather than whether anyone can get out. These are the real numbers for four of
   * the largest markets on Solana, every one of which it called unbacked.
   */
  it.each([
    ['BONK', 217_000_000, 517_000],
    ['JUP', 615_000_000, 2_000_000],
    ['JTO', 556_000_000, 2_000_000],
    ['PYTH', 64_000_000, 448_000],
  ])('does not call %s unbacked for having outgrown its pool', (_name, marketCapUsd, liquidityUsd) => {
    expect(codes(call({ marketCapUsd, liquidityUsd }))).toEqual([]);
  });

  it('still asks the ratio where the pool is small enough for it to mean something', () => {
    // Same 0.24% as BONK, on a pool a member could not exit. The share is not the point.
    expect(codes(call({ marketCapUsd: 20_000_000, liquidityUsd: 48_000 }))).toEqual(['ratio']);
  });

  it('separates plausible hype from a wash-traded chart', () => {
    const busy = assess(call({ marketCapUsd: 400_000, liquidityUsd: 40_000, volumeUsd: 1_600_000 }));
    expect(busy.level).toBe('caution');
    expect(busy.flags.map((f) => f.code)).toContain('churn');

    const farmed = assess(call({ marketCapUsd: 400_000, liquidityUsd: 40_000, volumeUsd: 6_000_000 }));
    expect(farmed.level).toBe('danger');
  });

  it('catches a call that already ran past what the source quoted', () => {
    // Source said $40K; the market says $200K. Whoever buys now is their exit.
    const read = assess(call({ marketCapUsd: 200_000, liquidityUsd: 30_000 }), 40_000);
    expect(read.level).toBe('danger');
    expect(read.flags.map((f) => f.code)).toContain('late');
  });

  it('tolerates the ordinary drift between a quoted and an observed market cap', () => {
    expect(codes(call({ marketCapUsd: 44_000, liquidityUsd: 20_000 }), 40_000)).toEqual([]);
  });

  it('flags an address we are not confident about', () => {
    const read = assess(call({ marketCapUsd: 80_000, liquidityUsd: 30_000 }, 0.5));
    expect(read.level).toBe('caution');
    expect(read.flags[0]!.code).toBe('weak-parse');
  });

  it('stays quiet when the source gave us no numbers to judge', () => {
    expect(assess(call({})).level).toBe('clear');
  });

  /**
   * DexScreener answers `liquidity: null` on a pool it holds no depth reading for, and every
   * check above needs that number — so silence used to read as a clean bill of health on the
   * token we knew least about. The card omits its liquidity line rather than printing a zero,
   * so nothing else on it hinted at the gap either.
   */
  describe('a market that will not tell us the depth', () => {
    it('does not call a token clear just because it could not be checked', () => {
      const read = assess(call({ marketCapUsd: 3_253, volumeUsd: 121_469 }), undefined, true);
      expect(read.level).toBe('caution');
      expect(read.flags.map((f) => f.code)).toEqual(['unknown-depth']);
    });

    // Before enrichment we simply have not looked, which is a fact about us rather than the
    // token. Flagging it there would mark every relayed call in the moment that matters most.
    it('says nothing when we have not been to the market yet', () => {
      expect(assess(call({ marketCapUsd: 3_253, volumeUsd: 121_469 })).level).toBe('clear');
    });

    it('leaves a real depth reading to the checks that already handle it', () => {
      expect(codes(call({ marketCapUsd: 300_000, liquidityUsd: 60_000, volumeUsd: 120_000 }))).toEqual([]);
    });
  });
});

/**
 * The half of the screen the market cannot answer.
 *
 * Every check above asks whether the pool can be sold into. None of them can ask whether the
 * seller will be *allowed* to sell, because that is not a fact about the pool. These tests are
 * about the two ways that answer goes wrong: reading a failed lookup as a clean bill of health,
 * and flagging so freely that the one flag that matters gets lost among the others.
 */
describe('what only the chain can say', () => {
  const HEALTHY: Stats = { marketCapUsd: 36_270, liquidityUsd: 16_910, volumeUsd: 26_410 };
  const DEV = '9AhKqLR67hwapvG8SA2JFXaCshXc9nALJjpKaHZrsbkw';

  /** A healthy call, so anything that shows up in the flags came from the chain facts. */
  function withChain(onchain: ParsedCall['onchain']): ParsedCall {
    return { ...call(HEALTHY), onchain };
  }

  const mint = (over: Partial<NonNullable<ParsedCall['onchain']>['mint']> = {}) => ({
    supply: 1_000_000n,
    decimals: 6,
    ...over,
  });

  const spread = (topShare: number, top10Share = topShare) => ({
    topShare,
    top10Share,
    poolAccounts: 1,
    examined: 20,
  });

  it('refuses a token whose owner can still stop you selling', () => {
    const read = assess(withChain({ mint: mint({ freezeAuthority: DEV }) }));

    expect(read.level, 'the purest rug there is').toBe('danger');
    expect(read.flags.map((f) => f.code)).toEqual(['freeze-authority']);
    expect(read.flags[0]?.detail, 'names who holds it, so it can be checked').toContain('9AhK');
  });

  it('refuses a token whose supply can still be printed', () => {
    const read = assess(withChain({ mint: mint({ mintAuthority: DEV }) }));

    expect(read.level).toBe('danger');
    expect(read.flags.map((f) => f.code)).toEqual(['mint-authority']);
  });

  // The healthy state, and the common one: pump.fun revokes both at launch. If this said
  // anything at all, every good token would carry a warning and the warnings would stop working.
  it('says nothing at all about a mint with both authorities revoked', () => {
    expect(assess(withChain({ mint: mint() })).flags).toHaveLength(0);
  });

  /**
   * The whole point of the module, stated as a test: silence is not a pass. A mint minted
   * seconds ago is exactly the case — the account exists before the indexers have it, and a
   * brand new coin is the one we are asked about fastest.
   */
  it('says the mint is unknown rather than passing it', () => {
    const read = assess(withChain({}));

    expect(read.level).toBe('caution');
    expect(read.flags.map((f) => f.code)).toEqual(['unknown-mint']);
  });

  // The relay path skips the chain read on purpose, since the round trip costs more than it
  // buys when another group has already posted. It must not therefore warn about every call.
  it('says nothing when the chain was never asked, as opposed to asked and silent', () => {
    expect(assess(call(HEALTHY)).flags).toHaveLength(0);
  });

  it('refuses one wallet that could end the token by itself', () => {
    const read = assess(withChain({ mint: mint(), holders: spread(0.62) }));

    expect(read.level).toBe('danger');
    expect(read.flags.map((f) => f.code)).toEqual(['whale']);
  });

  /**
   * The threshold below `WHALE_DANGER` could not be calibrated — the keyless RPC blocks the
   * holder call — so it states a number instead of refusing on one. This test is the guard on
   * that: an uncalibrated guess must never be able to kill a call on its own.
   */
  it('states a large holder as a number rather than refusing on an uncalibrated threshold', () => {
    const read = assess(withChain({ mint: mint(), holders: spread(0.31) }));

    expect(read.level).toBe('caution');
    expect(read.flags[0]?.detail).toContain('31.0%');
  });

  it('catches ten wallets holding between them what one of them could not', () => {
    const read = assess(withChain({ mint: mint(), holders: spread(0.09, 0.72) }));

    expect(read.flags.map((f) => f.code)).toEqual(['whale']);
    expect(read.flags[0]?.detail).toContain('top 10');
  });

  // One fact told twice reads as padding on a card someone has a second to scan.
  it('does not say the same thing twice when the top wallet already made the point', () => {
    const read = assess(withChain({ mint: mint(), holders: spread(0.55, 0.95) }));
    expect(read.flags.filter((f) => f.code === 'whale')).toHaveLength(1);
  });

  it('passes a token that is genuinely spread out', () => {
    expect(assess(withChain({ mint: mint(), holders: spread(0.04, 0.2) })).flags).toHaveLength(0);
  });

  /**
   * The holder call is refused constantly on a keyless endpoint. A caution on every call is a
   * caution nobody reads — and it would arrive in the same list as the freeze-authority flag,
   * so crying wolf here costs us the one flag that actually means "do not touch".
   */
  it('stays quiet about holders it could not read, having already read the mint', () => {
    expect(assess(withChain({ mint: mint() })).flags).toHaveLength(0);
  });

  // Both halves survive together: the market screen is not replaced by the chain screen.
  it('reports a thin pool and a live freeze authority in the same breath', () => {
    const thin = { ...call({ marketCapUsd: 50_000, liquidityUsd: 900 }), onchain: { mint: mint({ freezeAuthority: DEV }) } };
    expect(assess(thin).flags.map((f) => f.code)).toEqual(['thin', 'freeze-authority']);
  });
});
