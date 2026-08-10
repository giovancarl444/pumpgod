# pumpgod

Tracks other memecoin call groups over Telegram and republishes what we like to ours, as
fast as the network physically allows.

## How fast, and why

Measured on the dev machine (`npm run bench`):

| stage | p50 | notes |
| --- | --- | --- |
| reject ordinary chatter | **0.1µs** | ~95% of group traffic never gets past this |
| parse a real call | **7.2µs** | address extraction, stats, chain inference |
| send round-trip | 40–200ms | pure network — distance to Telegram's DC |

The shape of that table is the whole design argument: **our own code is four orders of
magnitude cheaper than one network hop.** So the work goes into removing round trips, not
micro-optimising JavaScript.

What that means in practice:

- **MTProto, not the Bot API.** A bot cannot read a group it has not been added to, which
  rules it out for tracking anyone else. MTProto also pushes updates down a socket that is
  already open, so there is no polling interval to lose.
- **Raw updates, not GramJS events.** The high-level `NewMessage` event resolves senders and
  chats before handing anything over, and that resolution can hit the network. We read
  `Api.UpdateNewChannelMessage` directly.
- **Every peer resolved at boot.** `getDialogs()` once at startup caches every access hash, so
  publishing never pauses to look up where it is publishing to.
- **Detect → fire → enrich.** We publish on whatever the source gave us, then *edit* the
  message when DexScreener answers. Enrichment is never allowed to gate a call.

The remaining latency is almost entirely distance to Telegram. If `npm run bench -- --network`
shows p50 above ~120ms, the fix is hosting near a Telegram DC, not code.

## Not missing calls

A missed call is infinitely slow, so this gets the same attention as latency. MTProto
delivers over a socket that can drop, and GramJS's own gap recovery does not guarantee every
message in the gap is replayed.

pumpgod tracks the last message id seen per source, persists it to `data/cursors.json`, and
explicitly pulls anything newer every `CATCHUP_INTERVAL_SEC`. A restart resumes from where
the last run stopped.

Recovered calls are old by definition, and posting one as if it were fresh is how a call
group loses trust — so **anything older than `MAX_CALL_AGE_SEC` (default 90s) never
auto-fires**, whatever the source's mode. It goes to the war room labelled `NOT fresh` with
its real age, and a human decides.

## Not calling garbage

Speed is worth nothing if it is spent arriving first at a rug. Every call is screened before
it is published, for whether it can be *exited* — never for whether it will run:

| Flag | What it catches |
|---|---|
| `dead` / `thin` | Pool too small to sell into, whatever the chart says |
| `ratio` | Market cap standing on almost no liquidity — the price is unbacked |
| `churn` | 24h volume far beyond what the pool can honestly support |
| `late` | Market cap already ran past what the source quoted; you would be their exit |
| `weak-parse` | The address came from a chart link, not a labelled `CA:` |

A `danger` read is treated exactly like staleness: **it never auto-fires**, however the source
is configured. It goes to the war room marked `HELD BACK` with the numbers spelled out.

This is free. The whole screen is arithmetic on numbers already in hand — about **40ns**,
against a 7µs parse and a 40–200ms network hop — so it costs nothing that speed would miss. It
runs a second time on real DexScreener data once enrichment lands, which is what catches a
call that already ran, and the public message is edited to say so.

## Setup

```bash
npm install
cp .env.example .env
```

1. **Get API credentials** at <https://my.telegram.org> → *API development tools*. Put
   `TG_API_ID` and `TG_API_HASH` in `.env`.
2. **Log in**: `npm run login`. Paste the resulting `TG_SESSION` into `.env`.
   This string is a full credential for the account — treat it like a password. It is
   gitignored; keep it that way.
3. **Join the groups** you want to track, from that account.
4. **List what you can see**: `npm run dialogs`. Copy the ids you want.
5. **Configure sources**: `cp config/sources.example.json config/sources.json` and edit.
6. **Set destinations** in `.env`: `PUMPGOD_CHANNEL` (public) and `WAR_ROOM_CHAT` (private
   staging group).
7. **Check it**: `npm run doctor`. Fix every ✗ before going any further.
8. **Run**: `npm run dev`.

`doctor` exists because the interesting ways to get that wrong all fail **silently**. A group
this account has been kicked from still resolves straight out of the entity cache, so no
message ever arrives and nothing logs. A public channel we are not an admin of accepts the
config happily and rejects the first real call. Reactions switched off in the war room leave
review mode unable to approve anything, forever. Each one is otherwise discovered by losing a
call, so they are proven up front instead:

- the session is authorised, and says which account it is
- every enabled source is resolved **and then actually read** — resolution lies, reading one
  message is the only honest test of membership — with the age of its last post
- post rights for both destinations, derived from the entity. Nothing is sent: a test message
  flashed into the public channel is visible to members even when it is deleted a second later
- the war room's reaction settings can carry a 🚀 approve and a 👎 skip

It exits non-zero on anything blocking, so a supervisor can gate the process on it.

## Proving the engine, not just the wiring

`doctor` proves the setup. `npm run drill -- --into <chat>` proves the engine. It posts a
synthetic call into a chat you have configured as a source and then gets out of the way: the
message comes back over the real socket, the real parser reads it, the real screen judges it,
the real dedupe admits it and the real publish path sends it. Nothing in the drill
reimplements any of that, which is the point — a drill carrying its own copy of the pipeline
would pass while the engine was broken.

It refuses to run unless `--into` names an **enabled source**, because posting into a chat
ingest is not watching would look like a clean pass and prove nothing at all. By default it
publishes to the war room; `--publish` sends the call to the real channel instead. Both
messages are deleted when it finishes.

The number it produces that nothing else can is **how long Telegram actually takes to hand you
a message somebody just posted**. `bench` measures the parser and the send leg, but both of
those start after we already have the message.

It earned its place on the first run. Every drill uses a freshly generated mint, and base58
can spell `lp`, `ca` and `age` — so the parser's short labels, which had no word boundaries,
were matching *inside* addresses. A mint containing `Lp` fabricated a pool address that was a
suffix of itself, and the Chart button pointed at it. A fixed test corpus was never going to
find that.

`LIVE=false` is the default. Calls are parsed, staged and logged but never published, so
you can watch it work for a day before it can embarrass you. Flip to `LIVE=true` when the
hit rate looks right.

## Calling a coin yourself

Relaying is only half of it. To call something you found, type this **in the channel**:

```
/signal DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

An address, a DexScreener link, a pump.fun link — anything the parser already understands.
Telegram delivers your own messages to every session of the account, so this works from
your phone against the bot running on a server. It works in the war room too, and `call` is
still accepted as an alias.

The command is **admin-only**, and the check costs nothing in the usual case: Telegram only
lets admins post in a broadcast channel, so the message existing is already the proof. In a
supergroup, where anyone can type, membership is read back once and cached.

The typed command is deleted before the lookup starts, so the channel never sits there
showing the instruction while it waits — the card is what appears, not the plumbing.

The command word is required. The war room is also where you *discuss* coins, and a chat
that publishes whatever gets pasted into it has no undo.

Unlike a relayed call, a manual one **resolves market data before publishing, not after**.
The relay path fires first because it is racing a group that has already posted; a coin you
call yourself is racing nobody, so the round trip is free. More to the point, an address on
its own carries no numbers — the tradability screen would have nothing to read and would
pass everything, which is exactly the guarantee worth keeping. If DexScreener has no pool
for it, there is nothing to buy, and pumpgod says so instead of posting a naked address.

Because the numbers are already in hand, a manual call is posted **as the coin's own artwork
with the card as its caption**. The image is downloaded here rather than handed to Telegram
as a URL: the URL form fails opaquely server-side, so a rate-limited CDN would be
indistinguishable from a coin with no logo. If it cannot be had — no artwork indexed, a slow
CDN, an aspect ratio Telegram refuses — the call still goes out as text. A call posted
without a picture is a call; a call not posted because a CDN was slow is a miss.

Whatever happens, you get told. Every outcome answers back in the war room — published,
held back by the screen and why, already called, or refused for its chain. Silence would be
indistinguishable from a dead bot, and the command has already deleted itself by then.

To see what a call will look like without posting it — and without a Telegram account:

```bash
npm run call -- <address or link>
```

That prints the exact public message, every link target, the artwork it would attach, and
the screen's verdict. It never posts: one process owns the dedupe window and the outcome
tracker, and a second writer would corrupt both.

Your own calls are tracked as source `manual`, so `npm run scorecard` answers the question
that starts to matter once you are picking coins yourself — are you beating the groups you
follow?

## Source modes

Set per source in `config/sources.json`:

- `shadow` — parse and journal only, never surface. Use for a week when adding a new group;
  `npm run replay` then tells you what it *would* have called.
- `review` — posts a card to the war room. React 🚀 to publish, 👎 to skip. One tap, and the
  approval latency is measured like everything else.
- `auto` — straight to the channel with no human step. Fastest path; only for sources whose
  hit rate you have already proven.

Approval is a **reaction**, not a button, because inline buttons are delivered to bots only —
and a bot could not read the source groups in the first place.

## Filtering

`CHAINS` in `.env` is the outermost gate and applies to every path — relayed, typed, or
detected. It ships as `solana`, because that is where the volume is and the one chain whose
whole path (price, liquidity screen, Buy link) is proven end to end. A call on anything else
is dropped before any source's own rules are consulted; a `/signal` on one is refused with
the reason rather than ignored, and an EVM address is turned away from its shape alone
without spending a round trip on it. Set `CHAINS=all` to lift the restriction.

Per source you can then set `minMarketCapUsd` / `maxMarketCapUsd` (skip what is already too
big to move), `chains` (narrower still), and `mute`.

Dedupe is global: the same contract from a second group inside `DEDUPE_TTL_SEC` does not
double-post, it is recorded as a confirmation and shown as `2× confirmed`.

## Operating it

```bash
npm run doctor           # prove the setup before a call depends on it
npm run drill -- --into <chat>   # prove the engine relays a real call, end to end
npm run dev              # run it
npm run call -- <addr>   # preview a call you'd make yourself (posts nothing)
npm run bench            # parser latency
npm run bench -- --network   # add send round-trip (posts probes to the war room)
npm run replay           # re-run the journal through the current parser
npm run scorecard        # what each source's calls actually did
npm run recap            # what the X feed would post (posts nothing)
npm test                 # parser + message rendering + outcome tracking
```

Everything the bot sees is journalled to `data/journal-YYYY-MM-DD.jsonl`, and `replay` is how
you check a parser change against real traffic instead of guesses.

## Which sources are worth following

Every call is re-priced against DexScreener every `TRACK_INTERVAL_SEC` for 24 hours, and the
entry, peak, time-to-2x/5x/10x and whether liquidity was pulled are written to
`data/tracked.json`. Shadow calls are tracked too — finding out what a group *would* have made
you, before trusting it, is the entire point of shadow mode.

```
  SOURCE            N     MED PEAK   2x      5x      10x     RUG     MED ENTRY   MED→2x
  ─────────────────────────────────────────────────────────────────────────────────────
  soaps             22    2.50x      59%     27%     14%     5%      $41K        2m
  noisegroup        22    0.70x      5%      0%      0%      27%     $41K        15m
  newgroup          1     3.00x      100%    0%      0%      0%      $129K       5m
```

Peak is a **median**, not a mean: one 200x drags a mean somewhere useless, and the question is
what a typical call from this group does, not the best thing that ever happened. Sources under
20 calls sort to the bottom however good they look, because people read the table top-down and
three lucky calls is not evidence. `npm run scorecard -- --called` restricts it to calls
actually published.

That table is the promotion rule: `shadow` → `review` → `auto` on the numbers, not on vibes.

## Growing the channel

A call group grows on proof, and every call we publish is already measured: entry, peak, and
how long the run took. The X feed is that record, posted automatically.

```
  ┌─ solana:DH5K…pump:10x · 70/280
  │ $ZHAO did 10x ⚡
  │
  │ called at $33.2K → $332K
  │ 24m
  │
  │ https://t.me/pumpgod_fun
  └─
  ┌─ daily:2026-08-09 · 105/280
  │ pumpgod · 9 Aug
  │
  │ 3 calls
  │ 2 × 2x · 1 × 5x · 1 × 10x
  │ best $ZHAO 12.4x · 10x in 24m
  │
  │ https://t.me/pumpgod_fun
  └─
```

Three rules are enforced in code, because each one is a way accounts like this lose credibility:

- **Only calls we actually published.** Shadow and dry-run calls are tracked precisely so we can
  judge a source privately. Posting one as ours would be a lie the public channel disproves —
  it is a timestamped record anyone can check a post against.
- **The numbers multiply out.** A milestone post shows entry × that milestone, not the recorded
  peak cap. The two disagree slightly when they were sampled a moment apart, and a post whose
  own arithmetic fails is the first thing a sceptic notices.
- **The denominator is in the daily recap.** `3 calls` sits above the winners, and a flat day
  says `none ran — that happens`. A group that only ever shows its winners is the one nobody
  believes.

Times are always attached to the milestone they belong to (`12.4x · 10x in 24m`), never to the
peak — the time to 2x is not the time to the top.

```bash
npm run recap    # exactly what would post, without an X account existing
```

`X_MIN_MULTIPLE` is the floor (default 5x). Posting every 2x burns the free tier's ~500
posts/month and trains people to scroll past. Only the best milestone a coin reached is posted,
so a 12x does not also produce a 5x post.

Credentials come from developer.x.com → your app → Keys and tokens. All four are needed, and
the **access token pair must be regenerated after granting Read AND Write** or posting fails
with a 403. Leave them blank and the feed stays off while `npm run recap` still previews it.
Posting also requires `LIVE=true`, so nothing goes public by accident.

## Making money from it

Trading terminals attribute a referral when someone **signs up** through your link, then pay a
share of that person's fees for as long as they trade. So the revenue does not come from
decorating each Buy button — it comes from one link being read on every call, by people who
are already about to buy something.

`REFERRAL_URL` is rendered once per public call, above the footer. `TRADE_URL_SOL` and
`TRADE_URL_EVM` are templates (`{address}`, `{chain}`) so the Buy button deep-links into
whichever terminal you actually use. Both live in `.env`, never in the repo.

Taking a cut of trades directly — an in-Telegram buy button with a wallet pumpgod controls —
earns more per user, but it means holding other people's keys. That is a custody product with
a custody product's failure mode, and a different legal posture, and it should not be built
before there is an audience to justify it. The non-custodial version (the user signs in their
own wallet, a fee instruction rides along in the transaction) gets most of the revenue with
none of the custody, and is the right shape when the time comes.

## Roadmap

**Phase 1 (this)** — track groups, relay what we like, measure everything.

**Phase 2 — stop being second.** Relaying another group is by definition behind them.
The edge is detecting on-chain: new pool creation on Solana/Base via a geyser or mempool
feed, which puts us ahead of every group we currently follow rather than behind them.
The journal from phase 1 is what tells us which signals are worth acting on.

**Phase 3 — distribution.** The X feed above is the first half. The second is TikTok:
auto-generated recap videos of calls that ran, rendered straight from `data/tracked.json` —
it already holds the entry, the peak and how long the run took, which is exactly what a recap
needs. Remotion is a React renderer for video, which is why this is a TypeScript codebase.

## Layout

```
src/
  parse/      address extraction, chain inference, stat fields — pure and synchronous
  telegram/   MTProto client, raw-update ingest, fast send, HTML→entity compiler
  pipeline/   routing, dedupe, enrichment, tradability screen, manual calls
  format/     message rendering
  metrics/    latency histograms
  store/      journal (buffered, off the hot path)
  track/      outcome tracking — entry, peak, milestones, rugs
  social/     X feed — milestone posts, daily recap, OAuth 1.0a posting
scripts/      login, doctor, drill, dialogs, call, bench, replay, scorecard, recap
```
