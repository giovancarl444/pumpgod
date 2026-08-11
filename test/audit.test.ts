import { describe, expect, it } from 'vitest';
import { apply, judge, type Finding } from '../scripts/audit';
import type { TrackedCall } from '../src/track/tracker';

/**
 * The audit rewrites the track record, which is the one file here that cannot be regenerated
 * from anything we control. So the rule it repairs by is worth pinning: a price is an
 * observation and a market cap is arithmetic standing on one, and a repair that moves the first
 * without the second leaves a row quietly disagreeing with itself — which is the same class of
 * fault the tool exists to find.
 */

/** How many tokens the pair of figures implies. The one thing a repair must not change. */
function supply(price: number | undefined, mc: number | undefined): number {
  return (mc ?? 0) / (price ?? 1);
}

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    id: 'shadow-tg:rival-1',
    sourceId: 'tg:rival',
    chain: 'solana',
    address: 'Coin',
    outcome: 'shadow',
    calledAt: 1_700_000_000_000,
    entryPriceUsd: 0.001,
    entryMcUsd: 100_000,
    poolAddress: 'pool',
    ...over,
  } as TrackedCall;
}

/**
 * The report has one number in it that carries weight — how many recorded figures were never
 * true. Everything else is the ordinary gap between a sampled peak and a charted one. So the
 * line between "the chart knows better" and "this was a lie" is the thing worth pinning, and it
 * is the line that was already wrong once: the fiction marker used to be set only in the peak
 * branch, so the worst entry in the whole record printed as unremarkable.
 */
describe('telling a wrong number from a merely improved one', () => {
  it('calls a wildly wrong entry a fiction, not a refinement', () => {
    // SPX6900: the pool was SPY / SPX6900 and the chart answered for the SPY side. Recorded as
    // verified against the chart, which is our highest confidence marker — so the flag being
    // set is not enough on its own to trust a figure, and this is the case that proves it.
    const [found] = judge(call({ entryPriceUsd: 772.9697, entryFromChart: true }), 0.000119, undefined);

    expect(found?.what).toBe('entry');
    expect(found?.fiction).toBe(true);
  });

  /**
   * A coin too new to have candles when it was scraped gets priced here for the first time.
   * There is no disagreement in that — there was nothing to disagree with. Counting it as a
   * number that was never true would inflate the one figure that is supposed to mean something,
   * and it would do it in the direction that makes our own tooling look busiest.
   */
  it('does not call a first-ever price a fiction', () => {
    const [found] = judge(call({ entryPriceUsd: undefined, entryMcUsd: undefined }), 0.000119, undefined);

    expect(found?.what).toBe('entry');
    expect(found?.was).toBeUndefined();
    expect(found?.fiction).toBeFalsy();
  });

  it('calls a peak far above its own chart a fiction', () => {
    // PARKIFY, the row that put eight separate channels at the top of the leaderboard at once.
    const [found] = judge(call({ athPriceUsd: 1.43 }), undefined, { priceUsd: 0.000481, at: 1_700_000_100_000 });

    expect(found?.what).toBe('peak');
    expect(found?.fiction).toBe(true);
  });

  /**
   * A call still inside its window has a peak that is the best of however many samples we took,
   * so the chart sitting above it is the ordinary work of the tool rather than news. If this
   * read as a fiction the report would be all noise and the real line would be lost in it.
   */
  it('treats a peak the chart merely knows better as ordinary', () => {
    const [found] = judge(call({ athPriceUsd: 0.001 }), undefined, { priceUsd: 0.0024, at: 1_700_000_100_000 });

    expect(found?.what).toBe('peak');
    expect(found?.fiction).toBeFalsy();
  });

  it('says nothing about a row the chart agrees with', () => {
    expect(judge(call({ entryPriceUsd: 0.001, entryFromChart: true }), 0.001, undefined)).toHaveLength(0);
  });
});

describe('adopting the chart over a recorded number', () => {
  /**
   * SPX6900, exactly. The busiest pool was SPY / SPX6900 and the candles came back priced in
   * SPY, so the entry went in at $772.97 against a real $0.000119 — and the market cap scaled
   * off it read $773bn on a coin worth a fraction of that.
   */
  it('carries the market cap along when the entry moves', () => {
    const row = call({ entryPriceUsd: 772.9697, entryMcUsd: 772_963_351_061 });
    const tokens = supply(row.entryPriceUsd, row.entryMcUsd);
    apply({ call: row, what: 'entry', was: row.entryPriceUsd, now: 0.000119, fiction: true });

    expect(row.entryPriceUsd).toBe(0.000119);
    // Supply is what survives the correction — a billion tokens either way. It is the cap that
    // was never anything but the price times that, so it moves and the coin stays the same size.
    expect(supply(row.entryPriceUsd, row.entryMcUsd)).toBeCloseTo(tokens, 0);
    expect(row.entryMcUsd).toBeLessThan(200_000);
    expect(row.entryFromChart).toBe(true);
  });

  /**
   * The peak price was sampled from the pool we were actually watching, so it is evidence in its
   * own right and a wrong *entry* is no reason to throw it away. Only the cap hanging off the
   * entry is invalidated. Dropping the price here would turn a repairable row into an unpriced
   * one, which the scorecard reads as a call nobody can score.
   */
  it('keeps a peak the entry correction says nothing about', () => {
    const row = call({ entryPriceUsd: 772.9697, entryMcUsd: 772_963_351_061, athPriceUsd: 0.00012, athMcUsd: 1 });
    apply({ call: row, what: 'entry', was: row.entryPriceUsd, now: 0.000119, fiction: true });

    expect(row.athPriceUsd).toBe(0.00012);
    // Rescaled through the corrected entry, so the peak's cap and its price still describe one
    // coin — the same supply as the entry, at the higher price.
    expect(supply(row.athPriceUsd, row.athMcUsd)).toBeCloseTo(supply(row.entryPriceUsd, row.entryMcUsd), 0);
  });

  it('scales the peak market cap from the entry when the peak moves', () => {
    const row = call({ athPriceUsd: 0.0012, athMcUsd: 120_000 });
    apply({ call: row, what: 'peak', was: 0.0012, now: 0.004, at: 1_700_000_100_000 });

    expect(row.athPriceUsd).toBe(0.004);
    // 4x the entry price, so 4x the entry cap. The multiple is the number the scorecard ranks
    // on, and it has to come out the same whichever of the two figures you compute it from.
    expect(row.athMcUsd).toBe(400_000);
    expect(row.athAt).toBe(1_700_000_100_000);
    expect(row.athFromChart).toBe(true);
  });

  /**
   * Our own entry went out on a card people read and acted on. Aligning the stored number to the
   * chart afterwards would leave our history disagreeing with our published history, and a group
   * that edits its own entry prices later is the exact thing this record exists not to be. The
   * peak is different — nothing was published about it — so it is still corrected.
   */
  it('will not revise the entry of a call we published', () => {
    const row = call({ outcome: 'called', entryPriceUsd: 0.0000472, entryMcUsd: 47_200 });
    apply({ call: row, what: 'entry', was: row.entryPriceUsd, now: 0.0000473 });

    expect(row.entryPriceUsd).toBe(0.0000472);
    expect(row.entryMcUsd).toBe(47_200);

    apply({ call: row, what: 'peak', was: undefined, now: 0.0000946, at: 1_700_000_100_000 });
    expect(row.athPriceUsd).toBe(0.0000946);
  });

  it('records a peak on a row that never had one', () => {
    const row = call();
    apply({ call: row, what: 'peak', was: undefined, now: 0.002, at: 1_700_000_100_000 });

    expect(row.athPriceUsd).toBe(0.002);
    expect(row.athMcUsd).toBe(200_000);
  });
});
