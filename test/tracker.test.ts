import { describe, expect, it } from 'vitest';
import { applyQuote, type TrackedCall } from '../src/track/tracker';

const T0 = 1_700_000_000_000;

function call(overrides: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'x',
    sourceId: 'soaps',
    outcome: 'called',
    chain: 'solana',
    address: 'Abc',
    calledAt: T0,
    ...overrides,
  };
}

describe('applyQuote', () => {
  it('takes entry from the first real observation', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, mcUsd: 36_000, liquidityUsd: 20_000 }, T0);
    expect(c.entryPriceUsd).toBe(0.001);
    expect(c.entryMcUsd).toBe(36_000);
  });

  it('does not move entry on later observations', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.005, liquidityUsd: 20_000 }, T0 + 60_000);
    expect(c.entryPriceUsd).toBe(0.001);
    expect(c.lastPriceUsd).toBe(0.005);
  });

  it('records milestones once, at the time they were first reached', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.002, liquidityUsd: 20_000 }, T0 + 30_000);
    applyQuote(c, { priceUsd: 0.011, liquidityUsd: 20_000 }, T0 + 90_000);
    // Falling back below a milestone must not rewrite when it was hit.
    applyQuote(c, { priceUsd: 0.0005, liquidityUsd: 20_000 }, T0 + 200_000);

    expect(c.timeTo2xSec).toBe(30);
    expect(c.timeTo5xSec).toBe(90);
    expect(c.timeTo10xSec).toBe(90);
  });

  it('keeps the peak after a retrace', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, mcUsd: 10_000, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.02, mcUsd: 200_000, liquidityUsd: 40_000 }, T0 + 60_000);
    applyQuote(c, { priceUsd: 0.003, mcUsd: 30_000, liquidityUsd: 15_000 }, T0 + 120_000);

    expect(c.athPriceUsd).toBe(0.02);
    expect(c.athMcUsd).toBe(200_000);
    expect(c.athAt).toBe(T0 + 60_000);
    expect(c.lastPriceUsd).toBe(0.003);
  });

  it('flags a rug when liquidity is pulled, even if a price is still quoted', () => {
    const c = call();
    applyQuote(c, { priceUsd: 0.001, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0.0009, liquidityUsd: 12 }, T0 + 60_000);
    expect(c.rugged).toBe(true);
  });

  it('ignores a missing or nonsensical price without corrupting entry', () => {
    const c = call();
    applyQuote(c, { priceUsd: undefined, liquidityUsd: 20_000 }, T0);
    applyQuote(c, { priceUsd: 0, liquidityUsd: 20_000 }, T0 + 1000);
    applyQuote(c, { priceUsd: Number.NaN, liquidityUsd: 20_000 }, T0 + 2000);
    expect(c.entryPriceUsd).toBeUndefined();

    applyQuote(c, { priceUsd: 0.004, liquidityUsd: 20_000 }, T0 + 3000);
    expect(c.entryPriceUsd).toBe(0.004);
  });
});
