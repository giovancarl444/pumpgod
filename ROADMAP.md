# Pumpgod — the whole plan, in two halves

**Status: code freeze on the engine.** Section 1 is parked exactly where it is. Section 2 is the
focus, and it is where the next stretch of work happens.

The reason for the order is worth stating once, because it is easy to forget and expensive to
relearn: **the engine is not the product, it is the proof.** A perfect signal machine with forty
members is worth almost nothing. A decent one with a real audience and a record nobody can fake
is worth a great deal. We have spent the time to make the machine honest — from here the work is
making people care, and the honesty is the thing we sell.

> **A note on why this can work at all.** Every group in this space claims a track record and
> almost none can show one. Ours is generated automatically, timestamped in Telegram, priced from
> chain data, and it **publishes the losses too**. That is not a feature next to the signals. It
> is the only thing in the whole plan a competitor cannot copy with a screenshot editor, and
> every growth idea below is downstream of it.

---

# Section 1 — Engine (paused)

The signal machine. Full reasoning lives in `ENGINE.md`; this is the checklist view.

## 1.1 Working and live

- [x] `/signal <address>` publishes a clean card to the channel, with the coin's image
- [x] Live market data resolved before publishing, so the screen has real numbers to judge
- [x] Tradability screen — thin pool, dead pool, liquidity/mcap ratio, wash churn, late call
- [x] Every call tracked and re-priced every 60s for 24h
- [x] True all-time-high backfilled from chain candles, so the peak survives a restart
- [x] Milestone replies under the original card at 2x / 5x / 10x
- [x] Self-updating pinned scoreboard, **losses and unpriced calls included**
- [x] Buttons on the card, DM surface, Stars payments, promo slots
- [x] Member call competition, ranked on median peak with a minimum sample
- [x] `isPublished()` — the single gate between measured and claimed, with its own test
- [x] Coin names cannot inject HTML into our own card, or break a Telegram invoice

## 1.2 On-chain safety — shipped this session

- [x] Mint authority check — *can they still print supply?*
- [x] Freeze authority check — *can they stop you selling?* Verified against mainnet
- [x] Pool-vs-wallet detection via ed25519 on-curve test (cannot go stale, unlike an address list)
- [x] A live freeze/mint authority is the **one flag `/signal` cannot wave through**
- [x] "Could not check" is a distinct state from "checked and fine", everywhere
- [ ] **Holder concentration — blocked on an RPC key.** *"One dev holds 90%, instantly ignore"* is
      not running yet. Free tier at helius.dev, paste into `SOLANA_RPC`. See `CHECKLIST.md` 2b
- [ ] LP burned or locked — *can they pull the pool?*
- [ ] Bundle / sniper detection — was the launch bought by wallets funded together?

## 1.3 Not started (resumes after Section 2 has traction)

- [ ] **A2 — Discovery.** Watched wallets first, firehose as backfill. Lands in `shadow`,
      publishes nothing, accumulates a record before it is trusted
- [ ] **B — Widen the decision snapshot.** `TrackedCall` carries every feature the engines saw.
      Small, and nothing after it can be learned without it
- [ ] **C — Narrative Lane A.** Deployment-burst and name-cluster detection. Free
- [ ] **D — The 0–100 score** with two readable sentences, delivered to the war room behind a 🚀
- [ ] **E — Promotion by scorecard**, never because something looked good in testing
- [ ] **F — Lane B**, the paid X watchlist, only if A–E earn it

## 1.4 Blocked on you (minutes each, no code)

- [ ] Real topic id — `PUMPGOD_TOPIC=291` is a *message* id, not a topic id
- [ ] `WAR_ROOM_CHAT` is empty. **This now matters more:** a coin held back for a live freeze
      authority is shown in the war room with a 🚀 to publish anyway. With no war room there is
      nowhere for that card to go, so it is simply refused
- [ ] `REFERRAL_URL` empty and `TRADE_URL_SOL` has no ref code — **every call so far earned
      nothing, and that cannot be backfilled**
- [ ] `SOLANA_RPC` — unlocks the concentration check
- [ ] Revoke the bot token in @BotFather (it was pasted in plain text)
- [ ] X API credentials, with **Write** access regenerated or it 403s

---

# Section 2 — Growth (the focus)

## 2.0 The goal, in one line

**Become "The Group"** — the one that gets named when people talk about call groups, because it
is the one that publishes numbers anyone can check.

Everything below serves two pillars, and they are the make-or-break:

1. **Engaged members, always.** A group of 5,000 lurkers is worth less than 300 people who talk.
2. **Dedicated members.** People who would defend the group to a stranger.

This is genuinely binary. Groups in this space are either dead-quiet with fake screenshots, or
they are a scene. There is very little in between, which is the risk *and* the opportunity.

## 2.1 The order of operations (the Nick lesson)

He built roughly 200k followers **before** calling a single coin. Audience first, calls second.

Which means the content starts now and is **not** calls. It is the process, the measurements, the
losses, the "we tested 40 call groups and here's the table" material. That content is unique to us
because nobody else is measuring it, and **it does not require a single good call to exist.**

- [ ] Accept the four-week shape: content from week 1, calls blasted from week 4+
- [ ] Do not blast a track record before ~20 tracked calls. Below that a hit rate is noise and any
      sharp reader knows it. The codebase already picked the number: `MIN_SAMPLE = 20`

## 2.2 Membership — the "1 minute before everyone else" model

Your idea, and it is the strongest monetisation in the plan. It is honest, standard in real alpha
groups, and technically small given what is already built.

**How it works:** members get the call at T+0. The free channel gets the identical call at T+60s.
Nobody is misled, nobody gets a worse coin, and the thing being sold is the one thing that
genuinely has value in this market — *time*.

- [ ] Decide the delay (60s is the obvious default; 30s feels premium, 120s feels punitive)
- [ ] Decide the price. Stars only — Telegram forbids card processors for digital goods
- [ ] Free tier still sees everything, always. **The free channel is the funnel, not the leftovers**
- [ ] Build: members channel + delayed mirror to public. Reuses the existing publish path
- [ ] The public card should say it was called 60s earlier, with the price it was called at.
      **The delay markets the membership better than any ad could** — every free call is a
      demonstration of what being early was worth, in numbers, forever

**Other benefits worth stacking later:** the score before it is public, the war-room reasoning,
a members-only "what we passed on and why" feed.

## 2.3 The interactive agent

Your ask, noted in full: **one agent, one identity, across multiple servers** (our server for now,
pre-expansion) that answers people as best it can, writes channel messages primarily, reassures
people, handles the repetitive questions like membership, convinces well, and has some form of
improvement / learning / identity.

### Confirmed: this is buildable. Here is why it has never worked before.

The usual build is **a personality with a memory store**. That is a machine for producing
confident nonsense: it retrieves something that *sounds* related, says it warmly, and nothing in
the loop ever tells it that it was wrong. It drifts, it invents specifics, and in a call group it
eventually says something about a coin's price that is both false and a liability.

**What works instead is a spokesperson with a database.** The distinction is the entire answer:

| The version that fails | The version that works |
|---|---|
| Has opinions about coins | Has **facts about our record** |
| "Remembers" via a vector blob | Looks up `data/` — the real tracked calls |
| Personality drifts every message | Fixed persona + fixed answer set = consistent by construction |
| Learns from chat | Learns from **outcomes**: which answers preceded someone joining or staying |
| Answers anything | Answers a bounded set, and says "I don't know" outside it |

We are in an unusually good position for this, because **the hard half already exists.** The
agent does not need to guess how we performed — it can read it. "How did you do this week",
"did you ever call X", "what was your worst call", "is the membership worth it" all resolve to a
lookup against numbers that are already measured and already public.

### The one hard boundary

**The agent talks about us and our record. It never says whether a coin will go up.**

Cross that line and it becomes a liability that can end the channel — a bot giving financial
advice, wrong, in writing, at scale. Stay this side of it and it is exactly the asset you
describe. This is not a limitation to work around later; it is the thing that makes it shippable
at all.

### Yes, it is an investment, and here is the real argument for it

You asked whether dedicated agents across the ecosystem are an actual investment. They are, but
not for the reason usually given. The value is not saved labour — it is that **an agent that
answers instantly, at 3am, consistently, with real numbers, is a better experience than a human
team can provide**, and consistency is what turns a channel into a scene. The compounding asset
is the answer set plus the record it reads from, and both are ours.

- [ ] Persona + boundary file (who it is, what it never does)
- [ ] Bounded answer set, each backed by a real lookup
- [ ] Turn **off** Telegram privacy mode so the bot can see group messages (BotFather setting —
      by default a bot in a group only sees commands and replies to itself)
- [ ] Rate caps per user and per hour, so cost scales with value and not with chatter
- [ ] One process, many chat ids — "one agent across servers" is nearly free once it exists
- [ ] Measure it: which answers preceded a join, a stay, a subscribe. Same fitness-function shape
      the source scorecard already uses

## 2.4 Content — what we actually post

We have material nobody else has. In rough order of how unfair the advantage is:

- [ ] **The rival scorecard.** *"We measured 40 call groups for two weeks. Here is the table."*
      The single best content idea in the plan. Needs zero good calls of our own, is genuinely
      useful, is inherently viral, and every group on it will argue about it in public — which is
      the marketing
- [ ] **The losses.** *"We called this. It did -40%. Here's the chart."* Nobody does this, which
      is precisely why it lands. It is also the cheapest trust you will ever buy
- [ ] **The saves.** *"This coin was trending. Its freeze authority was live. Here is what that
      means and here is how to check it yourself."* Teaches, proves the machine, costs nothing
- [ ] **Before/after cards.** Called at $36K → peaked at $210K, with the timestamp
- [ ] **Building in public.** The process itself, while there is no record yet
- [ ] Never post a call as content before it is a *measured* call

## 2.5 Distribution and auto-posting — safely

Your instinct to use ready-made chain-posting tools is right, with one distinction that matters.

**Safe:** scheduling tools that post content we generate (Buffer, Typefully, Hypefury, or the X
API directly — the free tier's write limit is well above our volume). These touch nothing of
ours and break no rules.

**Not safe:** engagement-farm tooling — reply bots, follow/unfollow, pods, mass-DM. These get
accounts restricted or shadowbanned, and a restricted account is not recoverable on a timeline
that matters. **The account is the asset.** Do not risk it to save a week.

Also worth knowing before budgeting: **crypto ads are restricted on Meta and TikTok** — most
regions need pre-approval or a licence. Plan for organic as the main channel, not the fallback.

- [ ] X account posting daily, from the content list above
- [ ] Scheduler chosen and connected
- [ ] Then: image cards. **Steal the Polymarket bot's technique** — it beats its own website
      because it sends a *pre-rendered image* that Telegram's CDN serves, while the site ships
      JavaScript and boots a charting library. Render server-side, send a picture
- [ ] Then: video (Remotion) for TikTok/Reels. A project, not a task — schedule it once a record
      exists, since it amplifies proof and there is no proof yet

## 2.6 The expansion loop

The end state you described: multiple servers, several X accounts, all feeding each other.

- [ ] Invite-to-unlock — invite X friends to unlock levels or extra uses. Powerful, and worth
      building only once there is something people actually want access to
- [ ] Second server only after the first is genuinely alive. Two dead servers is not growth
- [ ] Cross-account amplification, once there is more than one account worth amplifying
- [ ] The agent spans all of them from day one — that is what makes it an ecosystem rather than
      a set of copies

## 2.7 The line we do not cross

Noted because it shapes what we can accept later, and it is easier to decide now than under
pressure with money on the table.

**Undisclosed paid promotion — being paid per pump without saying so — is the structure
regulators treat as fraud rather than marketing.** It is also the exact thing your previous
community's reputation problem came from. Disclosed sponsorships plus the affiliate rail we
already have is the version that survives scrutiny and still pays.

- [ ] Decide now, in writing: disclosed only. It shapes whether we can ever take brand deals
- [ ] Promo slots stay visually distinct from calls and **never enter the track record**
      (already enforced in code — `promo` is a separate outcome and `isPublished()` excludes it)

---

## What happens first, when the freeze lifts

Ranked by how much they move the two pillars, engagement and dedication:

1. **The rival scorecard content** — needs no good call, no audience, and no permission
2. **The agent** — turns a channel into a place people talk, which is pillar one
3. **The 1-minute membership** — the moment there is a record worth being early to
4. **Engine A2 (discovery)** — resumes when growth has traction, so the machine has something to
   be good at *for* somebody
