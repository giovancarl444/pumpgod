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
});
