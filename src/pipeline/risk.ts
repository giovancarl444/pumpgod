import type { ParsedCall, RiskFlag, RiskLevel, RiskRead } from '../types';

/**
 * Answers "can we get out of this", not "will this run". Nothing here predicts upside —
 * it only catches the shapes that make a call indefensible after the fact: a pool too thin
 * to sell into, a price that already ran on nothing, or a chart being churned by bots.
 *
 * Every check is pure arithmetic on numbers we already have, which is what lets it run on the
 * hot path before publishing — it measures around 40ns against a 7µs parse. A screen that
 * needed a network round trip would have to be skipped exactly when speed mattered most.
 */

/** Below this you cannot exit meaningful size, whatever the chart says. */
const THIN_LIQUIDITY_USD = 3_000;

/** Below this the pool is gone in any practical sense. */
const DEAD_LIQUIDITY_USD = 500;

/**
 * Liquidity as a share of market cap. A real launch opens well north of 10% and decays as
 * the price runs, so a thin ratio means either the price already ran a long way or the
 * liquidity was never there. Either way the buyer is exit liquidity rather than early.
 */
const THIN_RATIO = 0.02;
const SEVERE_RATIO = 0.008;

/** 24h turnover as a multiple of the pool. Genuine hype reaches this; wash farms blow past it. */
const CHURN_CAUTION = 30;
const CHURN_DANGER = 100;

/** How far market cap may drift from the source's quote before we are simply late to it. */
const LATE_MULTIPLE = 3;

/**
 * `claimedMcUsd` is the market cap the source quoted. Passing it enables the lateness check,
 * which is the risk specific to relaying: the number being stale when they posted means the
 * move already happened.
 */
export function assess(call: ParsedCall, claimedMcUsd?: number): RiskRead {
  const flags: RiskFlag[] = [];
  const { marketCapUsd: mc, liquidityUsd: liq, volumeUsd: vol } = call.stats;

  if (liq !== undefined) {
    if (liq < DEAD_LIQUIDITY_USD) {
      flags.push({ code: 'dead', detail: `liquidity ${usd(liq)} — pool is gone`, level: 'danger' });
    } else if (liq < THIN_LIQUIDITY_USD) {
      flags.push({ code: 'thin', detail: `liquidity ${usd(liq)} — cannot exit size`, level: 'danger' });
    }
  }

  // Only meaningful once the pool is big enough for the ratio to say anything; a $2k pool is
  // already flagged above and its ratio would just repeat the point.
  if (mc !== undefined && liq !== undefined && liq >= THIN_LIQUIDITY_USD && mc > 0) {
    const ratio = liq / mc;
    if (ratio < SEVERE_RATIO) {
      flags.push({ code: 'ratio', detail: `liquidity is ${pct(ratio)} of mcap — price is unbacked`, level: 'danger' });
    } else if (ratio < THIN_RATIO) {
      flags.push({ code: 'ratio', detail: `liquidity is ${pct(ratio)} of mcap`, level: 'caution' });
    }
  }

  if (vol !== undefined && liq !== undefined && liq > 0) {
    const churn = vol / liq;
    if (churn > CHURN_DANGER) {
      flags.push({ code: 'churn', detail: `${churn.toFixed(0)}× pool traded in 24h — likely wash`, level: 'danger' });
    } else if (churn > CHURN_CAUTION) {
      flags.push({ code: 'churn', detail: `${churn.toFixed(0)}× pool traded in 24h`, level: 'caution' });
    }
  }

  if (claimedMcUsd !== undefined && claimedMcUsd > 0 && mc !== undefined && mc > 0) {
    const moved = mc / claimedMcUsd;
    if (moved >= LATE_MULTIPLE) {
      flags.push({
        code: 'late',
        detail: `already ${moved.toFixed(1)}× the ${usd(claimedMcUsd)} the source quoted`,
        level: 'danger',
      });
    }
  }

  // Not a property of the token but of our read of it. A pool address scraped from a chart
  // link is the case where we publish a confident-looking card about the wrong thing.
  if (call.token.confidence <= 0.5) {
    flags.push({
      code: 'weak-parse',
      detail: `address taken from a ${call.token.origin} at ${Math.round(call.token.confidence * 100)}% confidence`,
      level: 'caution',
    });
  }

  return { level: verdict(flags), flags };
}

function verdict(flags: RiskFlag[]): RiskLevel {
  if (flags.some((f) => f.level === 'danger')) return 'danger';
  return flags.length ? 'caution' : 'clear';
}

function usd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(ratio: number): string {
  return ratio < 0.01 ? `${(ratio * 100).toFixed(2)}%` : `${(ratio * 100).toFixed(1)}%`;
}
