import type { ChainFacts, ParsedCall, RiskFlag, RiskLevel, RiskRead } from '../types';

/**
 * Answers "can we get out of this", not "will this run". Nothing here predicts upside —
 * it only catches the shapes that make a call indefensible after the fact: a pool too thin
 * to sell into, a price that already ran on nothing, a chart being churned by bots, or an
 * authority that lets someone stop the buyer selling at all.
 *
 * Every check is pure arithmetic on values already in hand, which is what lets it run on the
 * hot path before publishing — it measures around 40ns against a 7µs parse. A screen that
 * needed a network round trip would have to be skipped exactly when speed mattered most. The
 * chain facts are read *outside* this file, on the paths that can afford the round trip, and
 * arrive here as data; that is why adding them cost this function nothing.
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

/**
 * Above this the ratio has stopped answering the question, so it is not asked. The share
 * decays as a token matures, which makes it a statement about age rather than about exiting
 * once the pool is deep in absolute terms: BONK, JUP, JTO and PYTH all sit under 0.8% while
 * holding $450K to $2M of depth. A member selling $5k moves a pool this size by 2%, so
 * whether they can get out is settled by the depth itself and the ratio only adds a scare.
 */
const RATIO_ONLY_BELOW_USD = 250_000;

/** 24h turnover as a multiple of the pool. Genuine hype reaches this; wash farms blow past it. */
const CHURN_CAUTION = 30;
const CHURN_DANGER = 100;

/** How far market cap may drift from the source's quote before we are simply late to it. */
const LATE_MULTIPLE = 3;

/**
 * One wallet, pools excluded, holding this much can end the token on its own — so this is a
 * refusal rather than a warning, and it is the case the whole on-chain read was added for.
 *
 * Set where no calibration could move it. Half the supply in a single account that a person
 * holds the key to means the holder can halve the price unilaterally, and no reading of the
 * numbers makes that tradable. The caution threshold below is a different kind of number and
 * is treated as one.
 */
const WHALE_DANGER = 0.5;

/**
 * A number to *state*, not a number to refuse on.
 *
 * The honest position is that this one is not calibrated: the public RPC blocks the holder
 * call outright, so it was picked from how launches are known to be shaped rather than from a
 * distribution we measured. Two things follow. It flags at caution, so an uncalibrated guess
 * can never silently kill a good call. And it is a threshold rather than a verdict — once the
 * scorecard has real holder readings behind real outcomes, where it belongs becomes something
 * to look up rather than something to argue about.
 *
 * There is a known false positive worth naming: on an established token the largest non-pool
 * holder is often an exchange's hot wallet, which is on the curve and so reads as a person.
 * That is another reason it says a number instead of passing judgement.
 */
const WHALE_CAUTION = 0.2;

/** Ten wallets holding this much between them is the same problem spread thinner. */
const TOP10_CAUTION = 0.65;

/**
 * `claimedMcUsd` is the market cap the source quoted. Passing it enables the lateness check,
 * which is the risk specific to relaying: the number being stale when they posted means the
 * move already happened.
 *
 * `marketChecked` says we have already been to the market for this call. It changes only what
 * silence means — a token the market reports no depth for is a different thing from one we
 * have not looked up yet, and only the first is worth saying anything about.
 */
export function assess(call: ParsedCall, claimedMcUsd?: number, marketChecked = false): RiskRead {
  const flags: RiskFlag[] = [];
  const { marketCapUsd: mc, liquidityUsd: liq, volumeUsd: vol } = call.stats;

  if (liq !== undefined) {
    if (liq < DEAD_LIQUIDITY_USD) {
      flags.push({ code: 'dead', detail: `liquidity ${usd(liq)} — pool is gone`, level: 'danger' });
    } else if (liq < THIN_LIQUIDITY_USD) {
      flags.push({ code: 'thin', detail: `liquidity ${usd(liq)} — cannot exit size`, level: 'danger' });
    }
  } else if (marketChecked) {
    // DexScreener answers `liquidity: null` for a pool it has no depth reading on, and every
    // check below needs that number — so without this the screen returns a clean verdict on
    // the token it knows least about, and the card omits its liquidity line rather than
    // showing a zero, so nothing anywhere says we could not check. Unknown is not clear.
    flags.push({ code: 'unknown-depth', detail: 'no liquidity reading — depth unknown', level: 'caution' });
  }

  // Bounded at both ends. A $2k pool is already flagged above and its ratio would only repeat
  // the point; past `RATIO_ONLY_BELOW_USD` the depth answers the question on its own.
  const ratioWorthAsking = liq !== undefined && liq >= THIN_LIQUIDITY_USD && liq < RATIO_ONLY_BELOW_USD;
  if (mc !== undefined && liq !== undefined && ratioWorthAsking && mc > 0) {
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

  flags.push(...chainFlags(call.onchain));

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

/**
 * The half of the screen the market cannot answer.
 *
 * Everything above measures whether the pool can be sold into. Nothing above can tell you
 * whether you will be *allowed* to sell, because that is not a property of the pool — it is a
 * property of the mint, and only the chain has it.
 *
 * Exported so it can be tested and rendered on its own. Pure, like everything else here: the
 * round trip that produced these facts happened elsewhere.
 */
export function chainFlags(facts: ChainFacts | undefined): RiskFlag[] {
  // Nothing was asked. That is the relay path, where the chain read is skipped on purpose,
  // and inventing a flag for it would put a warning on every relayed call forever. A read
  // that was attempted and failed is a different thing, and is reported below.
  if (!facts) return [];

  const flags: RiskFlag[] = [];

  if (!facts.mint) {
    // The strongest check we have is also the one most likely to be missing, because a mint
    // seconds old is both the case worth checking and the case the indexers have not caught
    // up with. Saying so is the entire point — a card that omits the line reads as a pass.
    flags.push({ code: 'unknown-mint', detail: 'could not read the mint — authorities unknown', level: 'caution' });
  } else {
    const { freezeAuthority, mintAuthority } = facts.mint;
    if (freezeAuthority) {
      // Danger without qualification, and the only flag here that needs no threshold: the
      // holder of this key can freeze a buyer's account, after which they cannot sell at any
      // price. The pool stays deep, the chart stays green, and the money is gone anyway.
      flags.push({
        code: 'freeze-authority',
        detail: `freeze authority is live (${short(freezeAuthority)}) — they can stop you selling`,
        level: 'danger',
      });
    }
    if (mintAuthority) {
      flags.push({
        code: 'mint-authority',
        detail: `mint authority is live (${short(mintAuthority)}) — supply can still be printed`,
        level: 'danger',
      });
    }
  }

  // Deliberately silent when the holder call failed. It fails constantly on a keyless endpoint,
  // and a caution on every single call is a caution nobody reads — which would cost us the
  // freeze-authority flag above, since that one arrives in the same list. `unknown-mint` covers
  // the case where nothing at all could be read.
  const holders = facts.holders;
  if (holders) {
    if (holders.topShare >= WHALE_DANGER) {
      flags.push({
        code: 'whale',
        detail: `one wallet holds ${pct(holders.topShare)} of supply — they can end it alone`,
        level: 'danger',
      });
    } else if (holders.topShare >= WHALE_CAUTION) {
      flags.push({
        code: 'whale',
        detail: `top wallet holds ${pct(holders.topShare)} of supply`,
        level: 'caution',
      });
    } else if (holders.top10Share >= TOP10_CAUTION) {
      // Only when no single wallet already made the point. Saying "top holder 30%, top ten 70%"
      // is one fact told twice, and a card that repeats itself reads as a card that is padding.
      flags.push({
        code: 'whale',
        detail: `top 10 wallets hold ${pct(holders.top10Share)} of supply`,
        level: 'caution',
      });
    }
  }

  return flags;
}

function verdict(flags: RiskFlag[]): RiskLevel {
  if (flags.some((f) => f.level === 'danger')) return 'danger';
  return flags.length ? 'caution' : 'clear';
}

/**
 * The flags that are not a matter of degree.
 *
 * Every other check says the buyer may not be able to sell *much*: the pool is thin, the price
 * already ran, the volume is farmed. Those are reasons to size down, and an admin looking at a
 * chart can reasonably decide they know better.
 *
 * These two say the buyer may not be allowed to sell *at all*, at any size, at any price,
 * whenever one key holder chooses. No position sizing answers that and no chart shows it —
 * which is exactly why the check is worth having, and why it is treated differently below.
 */
const UNSELLABLE = new Set<RiskFlag['code']>(['freeze-authority', 'mint-authority']);

/**
 * Whether the chain says someone else controls whether this can be sold.
 *
 * Separate from the danger level because it answers a different question. `level` asks how bad
 * the call is; this asks whether it is ours to make. It fires only on a positive reading — a
 * mint we could not reach never lands here, so a busy endpoint can never manufacture a refusal.
 */
export function unsellable(flags: RiskFlag[]): boolean {
  return flags.some((f) => UNSELLABLE.has(f.code));
}

/**
 * Which single flag a reader gets when there is only room for one.
 *
 * The public card shows one line, because a wall of caveats trains people to skip all of them.
 * Taking the first flag as that line is not the same thing as taking the worst, and once the
 * chain checks joined the list the two came apart in a way that mattered: the flags are built
 * in the order the checks happen to run, so a live freeze authority could sit behind a churn
 * warning, and a 🚨 icon could sit in front of a ⚠️ sentence.
 */
export function headlineFlag(flags: RiskFlag[]): RiskFlag | undefined {
  return (
    flags.find((f) => f.level === 'danger' && UNSELLABLE.has(f.code)) ??
    flags.find((f) => f.level === 'danger') ??
    flags[0]
  );
}

function usd(n: number): string {
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function pct(ratio: number): string {
  return ratio < 0.01 ? `${(ratio * 100).toFixed(2)}%` : `${(ratio * 100).toFixed(1)}%`;
}

/** Enough of an address to look it up, on a line that has to stay readable at a glance. */
function short(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
