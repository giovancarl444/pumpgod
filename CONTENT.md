# Content — what we post before we have a record

This is the working half of ROADMAP §2.4. That section lists what to post; this one decides how
it is framed, what may never be said, and what the actual drafts are.

Everything here is built to be postable **now**, with no good call of our own, because that is the
week-1 constraint: audience first, calls second.

---

## 1. The re-aim, and why it is not a wording preference

The obvious version of our best idea is **"we ranked 76 call groups."** That version is a trap,
and it took until the measurement was actually running to see why.

| "We ranked the callers" | "We priced every call they made" |
|---|---|
| A claim about **people** | A claim about **charts** |
| Argued against by *us* — our method, our motives | Argued against by the *candle data*, which is public |
| Needs ~20 priced calls per source to be honest | A single row is true or false on its own |
| Every group on it has a motive to discredit it | Nothing to discredit — go look at the chart |
| Postable in week 3 | **Postable this week** |

The ranking framing makes us the counterparty. Someone whose group scores badly does not argue
with the chart, they argue with *us* — our sample, our timing, our reasons for leaving out their
best call. And in the first weeks they would be right, because below `MIN_SAMPLE = 20` a median
genuinely is noise. We would be defending a number we had already written a guard against.

The pricing framing has no such exposure. "This channel called this contract at 14:32. Here is
what the chart did after 14:32" is either accurate or it is not, and anyone with the address can
settle it in ten seconds. There is no methodology to attack because there is barely a method —
we read a public page and read a candle.

**This also solves the timing problem, which is the real win.** The ranking cannot be published
until week 3. The pricing can be published the day the scraper has run, because it does not
depend on the sample being large. That moves our best content forward by two weeks, and week 1
is exactly when we have nothing else.

So: we publish **measurements**, and let readers do the ranking themselves. They will, loudly,
and that argument is the marketing. We never have to be in it.

---

## 2. The rules (these are what make it work, not the copy)

1. **Never call a group bad.** Publish the rows. The reader ranks. If a channel's median is
   0.6x, that number does the work and we stay out of it.
2. **The sample size travels with the rate, always.** "38% hit 2x" alone is a marketing claim.
   "38% of 61 priced calls hit 2x, 9 we could not price" is a measurement. The second one is
   less impressive and infinitely more believable, which is the entire trade we are making.
3. **Never post a number we cannot reproduce from chain data.** This is why the entry-price work
   mattered more than it looked: a price read at scrape time is a function of our poll interval,
   not of the call. It would be unfalsifiable, and therefore worthless as proof.
4. **Past tense only, about coins.** What a coin *did*. Never what it will do. This is the same
   boundary the agent has (ROADMAP §2.3) and for the same reason — the moment we forecast, we are
   a bot giving financial advice, in writing, at scale.
5. **Our losses post on the same schedule as our wins, from the same script.** Not as a humility
   flourish when it is convenient. If the losses are hand-picked, so are the wins.
6. **Say when we were wrong about our own machine.** The bug posts below are not self-flagellation;
   they are the strongest evidence that the numbers are not curated, because nobody fakes those.

---

## 3. Tier 0 — postable today, needs no data at all

### 3.1 The method post (the anchor — post this first)

> We are measuring 76 Telegram call channels.
>
> Not joining them. Not screenshotting them. Every one of those channels has a public web page,
> and every post on it carries the exact timestamp Telegram stamped it with.
>
> So: read the page, pull the contract address out of the post, take the timestamp, then ask the
> chart what that coin did *starting from that minute*.
>
> That is the whole method. No account, no permission, nothing anyone has to trust us about. If
> you have the contract address and the timestamp, you can reproduce any number we publish.
>
> Why bother: every group in this space posts its winners. The losers get deleted. So the
> published record of this entire industry is survivorship bias with a screenshot editor on top.
> We are recording the calls *before* anyone gets to choose which ones to remember.

**Why it works:** it is a useful, checkable, faintly outrageous thing to be doing, and it makes
the reader immediately want to know the answer. It also pre-frames every later post.

### 3.2 The survivorship post

> A call group with a 90% win rate and a delete button has a 90% win rate.
>
> This is not a jab, it is arithmetic. If losing calls get removed, the record is not a record.
> It is a highlight reel that took no skill to produce, and everyone reading it knows that, which
> is why nobody actually believes any of these screenshots — including the people posting them.
>
> The fix is boring: write the call down when it happens, before anybody knows how it turns out.
> Then you are stuck with it.
>
> We are stuck with ours. That is the product.

### 3.3 The "check it yourself" series (one per post, evergreen)

These teach, prove the machine exists, cost nothing, and are the most shareable thing we have
before there is a record.

- **Mint authority.** What it is, what it means that it is still live, and the exact place to
  look. Payoff line: *if the mint authority is live, the supply you are looking at is a
  suggestion.*
- **Freeze authority.** Same shape. *Freeze authority live means the deployer can stop you
  selling. Not "might rug" — can, specifically, stop your wallet from selling.*
- **Liquidity vs. market cap.** The PARKIFY case is ours and it is a genuinely great story: a
  pool advertising **$1.07bn of liquidity on a $225k coin**, off one transaction in 24 hours,
  while the pool people were actually trading in had $35k. Ranking by advertised depth takes the
  fiction every time. Ranking by traded volume does not.
- **One address, several coins.** An EVM address is a hash of the deployer and a nonce, so the
  same string is routinely a *different token* on another chain. We hit this live — one scraped
  address came back as three coins at once, on base, robinhood and ethereum.

### 3.4 The bug posts (building in public, and better than they sound)

> Our measurement was wrong four times before it was right. Here is the whole sequence, because
> the number at the end is only worth the story of how it was checked.
>
> The job: for each call, find the price at the exact minute it was posted. Not the price now —
> the price then. Otherwise you are crediting a group with every hour that passed before you
> happened to look.
>
> Share of calls we could actually price against the chart:
>
> **9%** — we were being rate-limited. A refused request returned "no data", which is
> indistinguishable from a coin that has no chart yet, so it fell back to the current price and
> reported success.
> **59%** — fixed that, and made the refusal say so out loud instead of whispering it to a debug
> log nobody reads.
> **75%** — four chains we already read calls on (base, blast, sui, ton) were missing from one
> lookup table. A missing chain isn't an error anywhere: the call resolves, the row saves, the
> price quietly falls back.
> **76%** — a fifth chain missing the same way.
> **100%** — one address can be *different coins on different chains*. An EVM address is a hash
> of the deployer and a nonce, so the same string gets reused. We had one that came back as three
> separate coins at once, on three chains, and we were adding their liquidity together.
>
> Every one of those four bugs had the identical symptom: everything reports success. That is why
> they survived. The fix that mattered most was not any single one of them — it was making the
> failure *say something* instead of returning a plausible number.
>
> There is now a test that fails to compile if anyone adds a chain without saying whether it can
> be priced.
>
> Posting this because a group inventing its track record does not publish the four bugs that
> were making everyone else's numbers look better than they were.

**Why this is good content and not navel-gazing:** it is proof the numbers are not curated. A
group inventing its record does not publish the story of the bug that made its record look better.

---

## 4. Tier 1 — needs the shadow data (days away, running now)

Framing rule for all of these: **a distribution, not a leaderboard.** No channel names on the
bad end, ever.

- **"N calls, priced."** *"In X days we recorded N calls across 76 channels and priced every one
  we could against the chart. Here is the distribution of what they did."* Histogram of peak
  multiple. This is the flagship and it names nobody.
- **"The typical call."** Median peak across the whole set. Most readers believe the typical
  call from a random channel is a 3x. The real number will be sobering, and sobering is
  shareable.
- **"What we could not price, and why."** The unpriced count as its own line, with the reasons.
  Nobody publishes their own missing data. It costs us nothing and it is unusually persuasive.
- **The time-to-2x number.** If the median winner takes hours rather than minutes, that is
  directly useful to the reader and quietly makes the case for the membership later.
- **Only once `MIN_SAMPLE` is met per source, and only for the good end:** name the channels that
  measured *well*. Praising by name is safe; the absence of a name says everything else, and we
  never had to say it.

## 5. Tier 2 — needs our own record (week 4+)

- Before/after cards, with the timestamp — called at $36K, peaked at $210K.
- **The worst call, posted deliberately.** The single highest-trust post available to us.
- The pinned scoreboard, which updates itself and includes the worst call by construction.
- The daily digest (`npm run digest` previews it, `AGENT_BROADCAST` gates it).

---

## 6. What we do not post

- Any call as content before it is a **measured** call.
- Any forecast, hedge, or "this looks strong."
- Any leaderboard with a named loser.
- Any number without its denominator.
- Any screenshot as evidence. We deal in addresses and timestamps, which is the whole point.
