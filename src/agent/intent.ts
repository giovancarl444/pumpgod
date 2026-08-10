/**
 * What somebody is asking, out of a list short enough to read in one screen.
 *
 * The list being short is the design, not a stage of it. An agent that can recognise anything
 * is an agent that will attempt anything, and the attempts it should not have made are exactly
 * the ones that cost something. Every name below has a matching function in `knowledge.ts`;
 * there is no default branch that improvises.
 */

/** A bounded set. Adding to it means adding a lookup, which is the point. */
export type Intent =
  /** Refused. Anything asking what a coin will do next — see `persona.BOUNDARY`. */
  | 'advice'
  /** How we have done. The scoreboard, read out. */
  | 'record'
  /** The worst call. Its own intent because volunteering it is the whole trust move. */
  | 'worst'
  /** The best call. */
  | 'best'
  /** Why anybody should believe the numbers. Our actual pitch. */
  | 'trust'
  /** What we check before a call goes out. */
  | 'screen'
  /** Price, benefits, how to join. */
  | 'membership'
  /** The member call competition. */
  | 'competition'
  /** Where the channel is. */
  | 'where'
  /** What this is at all. */
  | 'who'
  /** A greeting with no question attached. */
  | 'greeting'
  /** Outside the set. Answered by saying so. */
  | 'unknown';

/**
 * Questions about a coin's future, in the shapes people actually type them.
 *
 * Checked **first**, before anything else, and deliberately generous about what counts. A
 * message that pairs a forbidden question with a legitimate one — "gm, how'd you do this week,
 * also should I buy this?" — is refused whole rather than half-answered, because answering the
 * safe half is read as ducking the other and asking again works.
 *
 * The cost of a false positive here is one refusal where a plain answer would have done. The
 * cost of a false negative is a bot telling a stranger to buy something. Those are not
 * comparable, so the patterns lean the way that is merely annoying.
 */
const ADVICE: RegExp[] = [
  /\bshould i (buy|ape|get in|sell|hold|enter|invest|put)/,
  /\bworth (buying|a buy|aping|entering|it)\b/,
  /\b(good|bad) (buy|entry|play|coin|call|bet)\b/,
  /\b(will|gonna|going to) (it |this |that |\$?\w+ )?(pump|moon|run|rug|dump|fly|send|x\d|\d+x)/,
  /\b(is|are) (it|this|that|they|\$?\w{2,12}) (a )?(rug|scam|safe|legit|good)\b/,
  /\bprice (prediction|target)\b/,
  /\b(wen|when) (moon|lambo|pump)\b/,
  /\b(thoughts|opinion) on\b/,
  /\bwhat do you think (of|about)\b/,
  /\b(ape|aping|degen) into\b/,
  /\bentry (price|point)\b/,
  /\bshould we (buy|call|ape)\b/,
  /\bis it too late\b/,
  /\bdo i (buy|sell|hold)\b/,
];

/**
 * The rest, in the order they are tested.
 *
 * Order matters where phrasings overlap. "is the membership worth it" contains *worth it*,
 * which the advice list also claims — so the boundary check running first would refuse it. That
 * is the one place the generous refusal is too generous, and it is handled by an explicit
 * exemption rather than by weakening the pattern, because the pattern is protecting something
 * more important than this sentence is.
 */
const PATTERNS: Array<[Intent, RegExp]> = [
  // Before `record`, or "what was your worst" matches "how did you do" phrasings first.
  ['worst', /\b(worst|biggest loss|lost the most|worst call|any losses|ever lost|red)\b/],
  ['best', /\b(best|biggest (win|gain)|highest|top call|best call)\b/],
  [
    'record',
    /\b(track record|record|hit rate|win rate|how (did|do|have) you (do|done|perform)|results|stats|how many calls|performance|roi|pnl)\b/,
  ],
  [
    'trust',
    /\b(why should i (trust|believe)|how do i know|prove|proof|are you (real|legit|fake)|is this a scam|fake screenshots|trust you|verify)\b/,
  ],
  [
    'screen',
    /\b(how do you (pick|choose|find|screen|check|filter)|what do you check|criteria|due diligence|how does it work|how do the calls work|rug ?check|safety)\b/,
  ],
  [
    'membership',
    /\b(membership|member|subscribe|subscription|vip|premium|paid|how much (is|does)|price of|join early|early access|how do i join|sign ?up)\b/,
  ],
  ['competition', /\b(competition|contest|leaderboard|submit|my own pick|enter a coin|compete)\b/],
  ['where', /\b(channel|group|link|where (is|are)|invite)\b/],
  ['who', /\b(who are you|what is this|what are you|what do you do|about you|explain this)\b/],
  ['greeting', /^(gm|gn|hi|hey|hello|yo|sup|wagmi|good morning|good evening)\b/],
];

/** Membership questions that the advice patterns would otherwise claim. */
const NOT_ADVICE = /\b(membership|subscription|subscribe|vip|premium|join|channel|group)\b/;

/**
 * Classify one message.
 *
 * Case-folded and stripped of the leading @mention a group reply carries, so "@pumpgod_bot how
 * did you do" reads the same as the same sentence typed in a DM.
 */
export function classify(text: string): Intent {
  const clean = text
    .toLowerCase()
    .replace(/@[a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!clean) return 'unknown';

  // First, and on purpose. See the note on ADVICE.
  if (!NOT_ADVICE.test(clean) && ADVICE.some((re) => re.test(clean))) return 'advice';

  for (const [intent, re] of PATTERNS) {
    if (re.test(clean)) return intent;
  }

  return 'unknown';
}
