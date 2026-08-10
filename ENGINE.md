# The engine

What we are building next, why it is in this order, and what it costs. Everything here was
checked against live endpoints before it was written down — where something is unverified it
says so.

---

## The reframe

You described two engines. There are three, and the third is the one that makes the other two
worth having.

1. **The filter** — is this token safe to touch? Fast, deterministic, free, runs on everything.
2. **The narrative** — is there a reason this runs today? Slow, costs money, runs only on what
   the filter passed.
3. **The judge** — the `95/100`. How much should the channel trust *us* on this one, measured
   against every call we have made and every one we passed on.

The third is the one you described last and it is the most important, because it is the only
one that can be checked. A filter can be wrong quietly. A narrative can be a story anyone can
tell after the fact. A score that says 95 and is graded against what actually happened is a
claim that either survives contact with the record or does not, and that is the entire brand.

---

## What already exists, and is worth more than it looks

This is the part worth reading carefully, because the hardest pieces of a learning system are
already in the repo and are not currently being counted as such.

A system that genuinely learns needs four things. Most projects that claim to learn have none
of them and are running a prompt with a confident tone. We have all four:

**Ground truth.** `Tracker` re-prices every call for 24 hours and, since the candle backfill,
sets the true peak from the chart rather than from whatever we happened to sample. Every
decision gets a real number attached to it, automatically, whether we like the number or not.

**Feature snapshots with no lookahead.** `TrackedCall.risk` carries a comment that is worth
more than it appears: *"What the screen said when this arrived, not what it would say now."*
That is the discipline that everyone building this gets wrong, and getting it wrong means a
model that looks brilliant in testing and is worthless live, because it was quietly told the
future. It is already correct here.

**A fitness function.** `byCaller()` and `rank()` in `src/track/stats.ts`, surfaced by
`npm run scorecard`. It is keyed on `sourceId` and does not care what a source *is* — a rival
Telegram group, a member, or an engine version are all just ids with a record.

**A safe place to be wrong.** `shadow` mode records every call and publishes nothing.
`review` mode posts to the war room and waits for a 🚀 reaction before it publishes. Both
already work.

Put together, that gives the promotion rule for the whole engine, and it needs no new code:

> **Every engine version is a source.** `engine:v1` runs in `shadow`. It appears on
> `npm run scorecard` next to the rival groups and next to our own manual calls, judged by the
> same median-peak and rug-rate columns. It reaches `review` when its measured record earns it,
> and `auto` only after that. A new version cannot publish on a promise, because
> `isPublished()` will not let it.

That is what makes "always learning" true rather than a claim. The system cannot talk its way
into the channel. It has to earn its way in, in public, on a table anyone can read.

**The one gap:** `TrackedCall` records only `risk` and `riskFlags` as its decision snapshot.
That is two fields, and you cannot learn much from two fields. It needs to carry the full set
of things the engines saw and the score they gave. Small change, and it is the difference
between having a dataset and having a log.

---

## Engine 1 — the filter

Your description was right and the existing `risk.ts` is **not** it. Read its own summary:

> *"Answers 'can we get out of this', not 'will this run'. Nothing here predicts upside."*

It checks liquidity depth, liquidity-to-mcap ratio, wash-trading churn, and whether we are late.
All useful. But every single check you actually named — locked liquidity, one dev holding 90% —
is **absent**, because DexScreener cannot answer them. They are on-chain questions.

What Engine 1 adds, all of it free:

| Check | Question | Verified |
|---|---|---|
| Mint authority | Can they print more supply? | ✅ works on free RPC |
| Freeze authority | Can they freeze your wallet so you cannot sell? | ✅ works on free RPC |
| LP burned or locked | Can they pull the pool? | LP token supply — same call shape |
| Top-10 concentration | Does one wallet hold enough to end it? | ⚠️ see below |
| Bundle / sniper detection | Was the launch bought by wallets funded together? | needs transaction history |

I tested these against BONK on the public RPC. Mint and freeze authority come back cleanly and
free. **`getTokenLargestAccounts` returned HTTP 429** — it is an expensive call and the public
endpoint rate-limits it hard. That does not make it costly, it makes it keyed: Helius and
QuickNode both have free tiers that cover this comfortably at our volume. Budget stays at zero,
but it needs a key, and the public endpoint must not be used on the hot path.

The verdict is green/red exactly as you described, and it rejects most of what it sees. That is
the point, and it is also the cost control for everything downstream.

---

## Engine 2 — the narrative

You confirmed narrative-first, and your Doge-cat example is the reason it has to be. By the
time a story is visible *from the token*, it is priced in. The only way that example works is
if you were already watching before the cat existed.

But there is a cheaper and faster version of the same idea, and it costs nothing:

**The deployments are the news.** You do not need to read a post to know the dog's owner got a
cat. You need to notice that thirty tokens carrying a name nobody used yesterday all deployed
within an hour. That burst *is* the signal — it is on-chain, it is free, it arrives before any
news API has indexed anything, and it is the crowd telling you what the narrative is by what
they are spending money on.

So Engine 2 has two lanes, and they go in this order:

**Lane A — deployment bursts (free, build first).** Watch the names and symbols of new pools.
Cluster them. A cluster that did not exist yesterday and is being funded today is a narrative
breaking. Then the question flips to the useful one: *of the thirty tokens on this name, which
one has the liquidity and the safety profile to be the one that runs?* That is a question
Engine 1 already answers.

**Lane B — watched primary accounts (costs money, build second).** A curated list of accounts
that move markets, read in real time. This is the higher-ceiling version and it is where the
X API bill lands. Defer it until Lane A has proved the pipeline end to end, because Lane B is
$200/month to find out whether the rest of the machine works.

The asset either way is **the watchlist and the memory** — which names mattered, which accounts
preceded a run, what happened last time this pattern appeared. That compounds, and it is the
part a competitor cannot copy by screenshotting us.

### What discovery actually runs on

Verified live while writing this:

- **GeckoTerminal `/networks/solana/new_pools`** — free, no key, returns pools **under one
  minute old**, 20 a page. We already have a GeckoTerminal client for the candle backfill. This
  is the firehose and it is solved.
- **DexScreener `/token-profiles/latest/v1`** — free, no key, and it carries `description` and
  `links`. That is narrative text, handed over without an LLM having to guess at it.
- **pump.fun's API is Cloudflare-blocked** (HTTP 530). Not a route without more work than it
  is worth.

One live sample of the firehose contained a pool with $15 of liquidity and another reporting a
$21bn market cap. The stream is mostly garbage, which is exactly why Engine 1 runs first and
why it must be cheap.

---

## Engine 3 — the score

The one you asked for: a bold number, `95/100`, and two short sentences a person can read while
deciding whether to buy. Your definition is the right one and I want to write it down exactly,
because it constrains everything:

> *"how much should the people in my group trust me on this call, confidence related to the
> others I have experienced and called or passed"*

That is not a rating of the coin. It is a statement about **us**, relative to our own history.
Which means it is a **calibration** claim, and calibration is measurable:

> Of every call we scored 90 or above, what fraction actually did what we implied? If we say 90
> and it hits 40% of the time, the score is decoration and we should be told so by our own
> tooling before a member works it out.

This is the honest version of the thing every other bot fakes. Their AI score is a vibe with a
number bolted on and it is never graded. Ours gets graded by the same tracker that grades
everything else, and the grading goes on the pinned board next to the hit rate — *"when we said
90+, it ran 71% of the time"*. That line is worth more than the score itself, and no competitor
running a prompt can print it.

Consequences, which are non-negotiable if the number is going to mean anything:

- **The score is only real after roughly a hundred graded decisions.** Before that it is a guess
  with a decimal point. Shadow mode is where those hundred come from.
- **It goes to you privately first**, exactly as you said. `review` mode already does this —
  the score posts to the war room, you 🚀 it or you do not, and nothing reaches the channel
  unless you do. That surface is already built.
- **Every score is written to the record at decision time**, so it can be graded later. This is
  the `TrackedCall` change above.
- **When the score is wrong it stays visible.** Same rule as the losses on the board. A score
  we quietly stopped printing after a bad run is the screenshot problem again, wearing a
  different hat.

The two sentences under it are generated, short, and about *why this scored what it scored* —
which is a much easier thing for a model to do honestly than predicting a price, and much
harder to fake.

---

## The mailbox: do the bots talk over Telegram?

You asked whether the engines should pass work between each other as a Telegram "team",
reacting to each other's messages. Split answer, and the split matters:

**Not on the hot path.** The Bot API is rate-limited to roughly 30 messages a second globally
and about 20 a minute into one group. A filter that has to clear a firehose of new pools in
milliseconds cannot spend a network round trip and a rate-limit slot per token — and every
message the engines spend talking to each other is a message we cannot spend posting a signal.
Between engines, the mailbox is an in-process queue. It is faster, it is durable, and it cannot
be throttled by Telegram at the exact moment something is running.

**Yes as the place you watch it think.** This is what you actually want out of the idea and it
is worth building properly: a private war room where the engines narrate. Engine 1 posts a
digest of what it threw out and why. Engine 2 posts the narrative it thinks is forming. Engine 3
posts the score with its two lines, and you 🚀 it to publish. That is an observability surface
and a human gate at the same time, it is free, and `review` mode already implements the
reaction-to-publish half of it.

So: the team room is real, and it is where you supervise the engines. It is not the wiring
between them.

---

## Off-the-shelf Telegram bots

You asked about using existing bots for the pieces rather than hosting everything. Honest read:

**Good for cross-checking during development.** When Engine 1 says a token's LP is burned, run
the same token past an established rug-checker and see whether it agrees. Disagreements are how
you find bugs in your own checks cheaply, and it costs nothing.

**Bad as a dependency in the pipeline.** Three reasons, and the third is the real one: they
rate-limit and we would be sharing that limit with everyone; they can change output format or
disappear entirely with no notice; and we would be publishing a safety claim we cannot
reproduce. The entire pitch is *check our numbers yourself*. A green tick that means "some
other bot said so" is not checkable, and the first time one of them is wrong, it is our channel
holding the bag.

Same logic applies to hosted memory and agent frameworks. The learning that matters here is the
outcome record, and that is ours, in `data/`, in a format we control. It is the one asset that
cannot be rebuilt if a vendor turns something off.

---

## What it costs

**To start: nothing.** GeckoTerminal for discovery and candles, DexScreener for market data and
profile text, and a free-tier RPC key for the safety checks. Zero.

**LLM spend is controlled by Engine 1, not by the model choice.** If the firehose is a thousand
tokens a day and the filter passes two percent, that is twenty analyses a day. Cheap enough to
be a rounding error, and the *architecture* is what keeps it there. If the filter is loose, no
model is cheap enough.

**X API stays off until Lane A works.** $200/month is the wrong first purchase — it buys the
least certain part of the machine before the certain parts are proved.

---

## Order of build

This order is forced by data dependency, not preference. You cannot calibrate a score without
outcomes; you cannot get outcomes without candidates; you cannot get candidates without
discovery.

**A. Discovery + the real safety filter.** GeckoTerminal firehose in, on-chain checks bolted to
`risk.ts`. Everything lands in the tracker as `shadow`. Publishes nothing. Free, needs no
decisions from you beyond one RPC key.

**B. Widen the decision snapshot.** `TrackedCall` carries every feature the engines saw plus,
later, the score. From here on, every day the machine runs is a day of training data. This is
small and it is the highest-leverage change in the whole plan, because nothing after it can be
learned without it.

**C. Narrative Lane A.** Name clustering on the firehose, plus the profile text DexScreener
already hands us. Still shadow.

**D. The score, calibrated.** Once B has accumulated enough graded decisions to calibrate
against. Goes to the war room, to you, behind a 🚀.

**E. Promotion.** `npm run scorecard` decides, on the same table as the rival groups. Nothing
reaches the channel because it seemed good in testing.

**F. Lane B**, the paid watchlist — if and only if A–E earned it.

The switchover is a sample size, not a date, and the codebase already picked the number:
`MIN_SAMPLE = 20`.

---

## What will bite

- **A score that is not graded is the thing we said we would never do.** Printing a confident
  95 that nothing checks is the same lie as a fake track record, and it would be ours. The
  calibration line on the pinned board is not a nice-to-have, it is the price of printing the
  score at all.
- **Racing public news is a race against people with better infrastructure.** Where we can win
  is on obscurity — accounts and name-clusters nobody else is watching — and on not being
  wrong. For a retail audience, a filter that never hands them a rug beats being four seconds
  faster into one.
- **A learning system that publishes can learn to be confidently wrong in public.** Structurally
  prevented here, and only because shadow mode and `isPublished()` came first. Do not let
  anything route around them for a version that seems obviously good.
- **The firehose is mostly junk.** $15 pools, misparsed market caps, and wash farms. Anything
  measured on unfiltered discovery data will look far better or far worse than reality.
- **Free RPC tiers have real limits.** The public endpoint already 429s on the holder check.
  Key it, cache aggressively, and never put a per-token RPC call somewhere it runs on every
  poll for every tracked coin.
- **Two of these engines produce text for the public channel.** Everything learned about token
  names writing our HTML applies to model output too: it goes through the same escaping and the
  same length cap, and it is never trusted because it came from us.
