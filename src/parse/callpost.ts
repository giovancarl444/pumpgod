import { extractAddresses } from './addresses';

/**
 * Is this post a call, or is it a group talking about one it already made?
 *
 * ## Why this is the whole scraper
 *
 * Reading another group's public feed gives us every post they make, and only some of them are
 * calls. The rest are victory laps — "88X $CATE HIT 85.5M", "DAILY TOP 10 · last 24h", "9X
 * $NEEGY, called in private at 69K and mooned to 600K" — and every one of those carries the
 * same thing a call carries: a ticker, a market cap, sometimes a contract address.
 *
 * Recording one as a call is not a small error. It books the coin at the top of a move that has
 * already happened, so the group is credited with an entry nobody could have taken and then
 * charged for the entire retrace. A scorecard built on that is not merely noisy, it is
 * *systematically* wrong, and wrong in the direction that makes the loudest self-promoters look
 * like the worst callers. That would be a satisfying result and a false one.
 *
 * ## So it is deliberately trigger-happy
 *
 * The two mistakes are not symmetrical. Missing a real call costs us one row of sample, and the
 * numbers we do have stay true. Recording a recap poisons the numbers themselves. So anything
 * that smells retrospective is thrown out, and a group that writes its calls in an unusual way
 * is measured on fewer of them rather than measured wrongly — same rule as the risk screen,
 * where silence is never a pass.
 *
 * The reason is returned rather than a bare boolean so a pass can print *why* posts were
 * dropped. A scraper that quietly stops recognising calls looks exactly like a quiet week, and
 * the reason histogram is the only thing that tells the two apart.
 */
export type PostRead =
  | { call: true; address: string }
  | { call: false; why: 'no-address' | 'many-addresses' | 'retrospective' | 'promotional' };

/**
 * Talking about a call that already happened.
 *
 * Every one of these was written against a real post from a channel on the watchlist. They are
 * listed separately rather than merged into one monster expression because the failure mode
 * worth avoiding is a change here silently widening something over there.
 */
const RETROSPECTIVE: RegExp[] = [
  // "88X $CATE HIT 85.5M", "10.5X $HMM HIT 7.7M", "9X $NEEGY (SOL)". The multiple leads the
  // message, which is what a scoreboard post does and a call never does — a call cannot know
  // its own multiple yet.
  /^\W{0,8}\d+(?:\.\d+)?\s*x\b/i,
  // "did 12x", "hit 5x", "ran 40x", "reached 3x from call"
  /\b(?:did|hit|hits|reached|ran|mooned|peaked)\s+(?:a\s+)?\d+(?:\.\d+)?\s*x\b/i,
  // "5x from call", "12x since entry", "3x from our call"
  /\b\d+(?:\.\d+)?\s*x\b[^.\n]{0,24}\b(?:from|since|off)\b[^.\n]{0,16}\b(?:call|entry|alert|post)\b/i,
  // "called at 69K and mooned to 600K", "called earlier", "called it at"
  /\bcalled\b[^.\n]{0,30}\b(?:at|earlier|yesterday|privately|in private)\b/i,
  // "now at 38.6M", "now sitting at", after a peak figure
  /\bnow (?:at|sitting|trading)\b/i,
  // Celebration. Nobody congratulates anyone on a coin they have just this second called.
  /\b(?:congrats|congratulations|gz\b|well done|good call|nice call)\b/i,
  // Peaks, by any name.
  /\b(?:ath|all[-\s]?time high|new high|peak (?:mc|market ?cap|price))\b/i,
  // Round-ups: "DAILY TOP 10 · last 24h", "weekly recap", "wrap up".
  //
  // The top-N has to be heading a line. `top10` is also how a well-formed call card states
  // holder concentration — "top10 36%" — and matching that drops every call from the most
  // carefully written channel on the list. Real posts, not hypotheticals: see the test.
  /^\W{0,8}(?:daily|weekly|monthly|today'?s?|tonight'?s?)?\s*top\s?\d+\b/im,
  /\b(?:recap|round[-\s]?up|wrap[-\s]?up|leaderboard|report card|hall of fame)\b/i,
  /\b(?:results|performance)\s+(?:are|is|so far|of|for|this|today|update)\b/i,
  /\b(?:last|past)\s+(?:24\s?h(?:ours|rs)?|week|month|day)\b/i,
  /\b(?:yesterday|this week|so far this)\b/i,
  // "$40K → $2M", "69K to 600K". A journey, not a starting point.
  /\$?\d+(?:\.\d+)?\s*[km]\b\s*(?:→|->|=>|to)\s*\$?\d+(?:\.\d+)?\s*[km]\b/i,
];

/**
 * Somebody paid for this slot, so the coin is not the channel's pick.
 *
 * Matched against the opening line only, and that restriction is the whole design. Channels
 * append a fixed footer to every post — "🔔 Subscribe to @channel", "🔊Ad — <partner>", a row of
 * bot links — and a word matched anywhere in the message therefore matches *every* message that
 * channel will ever publish. One footer word cost @ThanosGems its entire output before this was
 * narrowed, and the damage is invisible: the channel simply contributes nothing and looks like
 * it never calls anything.
 *
 * A genuinely sponsored post leads with the disclosure, because that is what makes it a
 * disclosure. Looking only where it would honestly be gives up almost nothing and cannot
 * swallow a channel whole.
 */
const PROMOTIONAL: RegExp[] = [
  /^\W{0,8}(?:#ad\b|ad\s*[-–—:]|sponsored|advertisement|paid (?:promo|post)|promo\s*[-–—:])/i,
  /^\W{0,8}giveaway\b/i,
];

export function readCallPost(text: string): PostRead {
  const trimmed = text.trim();
  if (!trimmed) return { call: false, why: 'no-address' };

  const { tokens, pairAddress } = extractAddresses(trimmed);

  // The pool is dropped before counting. A chart link beside the mint is the single most
  // common shape a call takes, and counting the pool as a second token would reject almost
  // every well-formed call in the roster.
  const addresses = [...new Set(tokens.map((t) => t.address))].filter((a) => a !== pairAddress);

  if (!addresses.length) return { call: false, why: 'no-address' };

  // Two coins in one post is a list, and a list is a summary of things already called. A group
  // calling two coins at once posts twice, because it wants two charts and two entries.
  if (addresses.length > 1) return { call: false, why: 'many-addresses' };

  const opening = trimmed.split('\n', 1)[0] ?? '';
  if (PROMOTIONAL.some((re) => re.test(opening))) return { call: false, why: 'promotional' };
  if (RETROSPECTIVE.some((re) => re.test(trimmed))) return { call: false, why: 'retrospective' };

  return { call: true, address: addresses[0]! };
}
