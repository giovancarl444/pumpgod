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
| `unknown-depth` | The market reports no liquidity at all, so none of the checks above could run |

A `danger` read is treated exactly like staleness: **it never auto-fires**, however the source
is configured. It goes to the war room marked `HELD BACK` with the numbers spelled out. The one
exception is a coin you typed yourself — see [calling a coin yourself](#calling-a-coin-yourself).

`unknown-depth` is there because DexScreener answers `liquidity: null` for a pool it holds no
reading on, and every other liquidity check needs that number. Without it the screen returned a
clean verdict on the token it knew least about — and the card omits its liquidity line rather
than printing a zero, so nothing anywhere said the depth had not been checked.

This is free. The whole screen is arithmetic on numbers already in hand — about **40ns**,
against a 7µs parse and a 40–200ms network hop — so it costs nothing that speed would miss. It
runs a second time on real DexScreener data once enrichment lands, which is what catches a
call that already ran, and the public message is edited to say so.

## Setup

```bash
npm install
npm run setup
npm run doctor
npm run dev          # then type /signal <address> in your channel
```

`setup` asks for the two things only you can get, logs in, and lets you pick the channel from
a numbered list of the groups the account is actually in. It writes `.env` itself — the
session string is never printed, and re-running fills in only what is still missing.

It walks these four, which can equally be done by hand:

1. **API credentials** from <https://my.telegram.org> → *API development tools* →
   `TG_API_ID` and `TG_API_HASH`. These are for a **user account**, not a bot — a bot cannot
   read other people's groups, which is the entire first half of this.
2. **Log in.** Telegram sends a code to your phone. The resulting `TG_SESSION` is a full
   credential for the account — treat it like a password. It is gitignored; keep it that way.
3. **Destinations**: `PUMPGOD_CHANNEL` (public) and `WAR_ROOM_CHAT` (private staging group).
4. **`LIVE=true`** when you are ready to publish for real. It ships off.

`doctor` runs at any stage, including before any of that: on a blank `.env` it names every
value still needed at once and still proves the half of a call that needs no account — that
DexScreener answers and artwork downloads — so the first run says what already works.

That is a complete setup — you are calling your own coins. Relaying other groups is a
separate half, and it needs two more steps:

6. **Join the groups** you want to track, from that account, and `npm run dialogs` for ids.
7. **Configure sources**: `cp config/sources.example.json config/sources.json` and edit.

With no `config/sources.json` the bot says so once and runs anyway. Watching nobody is a
shape this is meant to run in, not a misconfiguration.

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
- `/signal` would actually be honoured in the channel. Posting and publishing are different
  rights: in a supergroup every member can post, so a setup that passes every check above can
  still ignore every command typed into it
- DexScreener prices a coin listed for years, and its artwork downloads — the two hops
  `/signal` makes before anything reaches Telegram, both of which fail looking like a bot
  that ignored you

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
lets admins post in a broadcast channel, so the message existing is already the proof. The
same holds for a supergroup message signed by the group rather than a person, which is how an
anonymous admin posts and is a right only admins have. Otherwise — a supergroup where anyone
can type — membership is read back once and cached.

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

**The screen advises a typed call rather than vetoing it.** Everywhere else a `danger` read
diverts the coin to the war room for a second look. Here it does not: `/signal` exists so that
discussing a coin and calling it are separate acts, which makes the command itself the
decision — and asking for that decision twice is how an admin's call goes quiet instead of
out, since the war room holding the second half is optional and may not be there at all. The
screen is not silenced. Its flag rides on the published card where the readers buying the coin
can see it, and the war room, if you have one, is told what was published over.

Whatever happens, you get told. Every outcome answers back in the war room — published,
published despite a flag, already called, or refused for its chain. Silence would be
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
npm run setup            # fill in .env: credentials, login, destinations
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

## The receipt, in the channel

A number posted on its own is a claim. The same number hanging under the original card — one
scroll from the entry price, in a message with a timestamp nobody can edit — is a receipt.
Two things run on that difference, both off the tracker, both without anyone typing.

**Milestones answer their own call.** When a call reaches 2x, 5x, 10x and up, the bot replies
underneath the card that made it:

```
  🚀 $ZHAO 10x · $33.2K → $332K · in 24m
```

Only the best milestone a coin has reached is sent, so a run to 10x does not also produce a
5x reply. Below 10x it lands silently: a 2x is a good afternoon, not a reason to buzz every
phone in the channel. A reply whose original card has been deleted still posts, unthreaded —
losing the thread beats losing the milestone.

**The pinned record edits itself.** One pinned message, rewritten in place whenever a number
moves:

```
  📊 pumpgod · track record

  34 calls since 10 Aug
  14 hit 2x · 6 hit 5x · 2 hit 10x (of 32 priced)
  median peak 1.84x

  best · $ZHAO 24.1x · 10x in 24m
  worst · $WIF 0.21x
  3 rugged · 2 we could not price
```

The worst call is on there on purpose, and so is the denominator, the rug count and the
number we could not price at all. A rate quoted without them is the trick every other group
is running. The worst is measured on where a call stands *now*, not on its peak — a peak is
never below 1x, so a record built only on peaks can never show a loss.

```bash
npm run scoreboard            # preview it
npm run scoreboard -- --pin   # post and pin it, once
```

Creating it is deliberately a one-shot script and not something the daemon can do. Pinning
notifies the channel and replaces whatever was pinned before; nothing that runs on a timer
should be able to do that. After it exists, the daemon only ever edits it — and skips the
edit entirely when nothing changed, because Telegram rejects an unchanged edit and would
otherwise 400 on every cycle forever.

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

### The call competition

A record only we can add to is a broadcast. `COMP_ENABLED` turns it into a competition: a member
DMs the bot `/submit <address>` and their pick is priced by the same tracker, on the same
schedule, against the same candles as ours. `/leaderboard` ranks everyone; `/me` shows one member
their own record.

```
  🏆 call competition

  🥇 @alice — 3.10x median (7 picks · best 12.4x)
  🥈 @bob — 1.80x median (9 picks · best 4.10x)
  🥉 @carol — 1.20x median (5 picks · best 2.30x)

  still qualifying (5 priced picks needed): @dave 2/5 · @erin 1/5

  Median peak over every pick, wins and losses. One pick a day.
  Picks are never posted in the channel. Updated 21:40.
```

Ranked on **median peak with a minimum sample**, never on best pick. A table topped by whoever
got luckiest once never changes again, and everyone below the winner correctly stops trying. The
minimum sample (`COMP_MIN_SAMPLE`, default 5) sorts anyone thinner to the bottom and names them as
still qualifying rather than hiding them, so the table can never be won by submitting on the day
the market ran. `COMP_PICKS_PER_DAY` is 1 for the same reason: at one pick a day the board
measures judgement, above it the board measures who submits the most.

A member's pick is **measured and never published**, and three separate things say so, because
one forgotten check should not be able to put an unvetted coin under our name:

- its own source id (`member:<userId>`), so a member's pick and a call of ours on the same coin
  stay two rows — which of us was earlier is the only interesting question, and a merged record
  cannot answer it;
- a `member` outcome, which `isPublished()` rejects, so it reaches neither the scoreboard, the X
  feed nor the milestone replies;
- a rank *above* `called`, so the outcome is sticky — even a code path that explicitly tries to
  record a member's pick as a call leaves it a member's pick. There is a test that does exactly
  that.

Submissions are DM-only, and the DM router is a separate module that holds no reference to the
signal path at all: `/signal` typed into a DM has no route to the channel by construction rather
than by a check. Only a `@username` is ever stored — Telegram's `first_name` is free text the
member chooses, and the leaderboard is rendered as HTML in a public channel.

## Making money from it

Trading terminals attribute a referral when someone **signs up** through your link, then pay a
share of that person's fees for as long as they trade. So the revenue does not come from
decorating each Buy button — it comes from one link being read on every call, by people who
are already about to buy something.

`REFERRAL_URL` is rendered once per public call, above the footer. `TRADE_URL_SOL` and
`TRADE_URL_EVM` are templates (`{address}`, `{chain}`) so the Buy button deep-links into
whichever terminal you actually use. Both live in `.env`, never in the repo.

### Selling a slot

The other revenue line is direct: someone pays to have their coin posted in the channel. Off by
default (`PROMO_ENABLED`), because turning it on changes what the channel is.

It runs entirely in DMs. `/promote <address>` to the bot resolves the coin, screens it, and only
then opens a Telegram Stars invoice — **nothing is charged for until we know we can post it**, so
a honeypot is refused for free rather than refunded after an argument, and the refund path stays
reserved for our own failures. Stars are the only currency a bot may charge in for something
delivered inside Telegram; enable them in @BotFather → Payments.

What gets posted is deliberately not a call. It is headed `📣 PAID PROMOTION`, it never wears the
`PUMPGOD ⚡` header, and it says in its own text that we did not choose the coin. It is recorded
under its own source id with its own `promo` outcome, ranked *above* `called` so the outcome is
sticky and no later code path can quietly upgrade a bought slot into a call of ours. `isPublished()`
asks for `called`, so a promotion cannot reach the scoreboard, the X feed or the milestone replies
by any route. Two tests hold that line.

That is not squeamishness. Undisclosed paid promotion is the structure regulators treat as fraud
rather than marketing, and it would make every other number here unverifiable — which is the only
thing this channel actually has. `PROMO_DAILY_LIMIT` is the rest of the answer: a rolling 24-hour
cap counting what was *posted*, because the difference between a channel and a billboard is a
number and it should be a small one.

If money is taken and the post fails, the Stars are refunded unconditionally; if the refund also
fails the order is left `owed` and shouted about at every boot, because a debt that only exists in
a JSON file is one nobody ever pays.

Taking a cut of trades directly — an in-Telegram buy button with a wallet pumpgod controls —
earns more per user, but it means holding other people's keys. That is a custody product with
a custody product's failure mode, and a different legal posture, and it should not be built
before there is an audience to justify it. The non-custodial version (the user signs in their
own wallet, a fee instruction rides along in the transaction) gets most of the revenue with
none of the custody, and is the right shape when the time comes.

## Roadmap

The bet is that in a market where every screenshot is fake and every group posts only its
winners, the group that publishes its own losses automatically is doing something nobody can
copy with a screenshot editor. Everything below serves that.

**Done — the receipts machine.** `/signal` publishes a card, the tracker re-prices it for 24
hours, milestones are reported under the call that earned them, and the pinned record edits
itself. Peaks are settled against on-chain candles when a call retires, so a restart cannot
understate a run.

**Next — the eyes.** A reader account, then every rival group in `shadow` mode. After ~20
calls per source the scorecard says which are worth copying, and only then do any of them get
promoted to `review` or `auto`. Blocked on a login; see [CHECKLIST.md](CHECKLIST.md).

**Done — a way to be paid without lying.** Buy and Chart are real inline buttons under every
call, and a DM surface sells a clearly-marked promotion slot for Stars that is structurally
barred from the track record.

**Done — member calls.** Members submit picks by DM, priced by the same tracker on the same
schedule, ranked on median peak with a minimum sample. Turns lurkers into competitors and gives
people who never call anything a reason to stay. A member's pick can never reach the public feed:
`isPublished()` is the single gate, and the outcome ranks above `called` so nothing can upgrade
one into a call of ours.

**Then — the rest of the interactive surface.** `callback_query`, which nothing here answers
yet: buttons currently only carry links. It was planned as the prerequisite for the competition
and turned out not to be one — the real blocker was DMs being dropped on ingest, and that is
open. So this is now wanted on its own merits: one tap to enter a pick beats typing an address.

**Then — distribution.** X media cards, then TikTok recap videos rendered straight from
`data/tracked.json`, which already holds the entry, the peak and how long the run took.
Remotion is a React renderer for video, which is why this is a TypeScript codebase. This is
a machine for amplifying proof, so it comes after there is proof.

**Cut:** on-chain pool detection. Sourcing coins is not the bottleneck.

## Layout

```
src/
  parse/      address extraction, chain inference, stat fields, DM verbs — pure and synchronous
  telegram/   MTProto client, raw-update ingest, fast send, HTML→entity compiler, Stars
  pipeline/   routing, dedupe, enrichment, tradability screen, manual calls, DMs, paid slots,
              member picks
  format/     message rendering
  metrics/    latency histograms
  store/      journal (buffered, off the hot path); promo orders and members (on disk)
  track/      outcome tracking — entry, peak, milestones, rugs; and what it all adds up to
  social/     the record, published — X feed, in-channel milestone replies, pinned scoreboard
scripts/      login, doctor, drill, dialogs, call, bench, replay, scorecard, recap, scoreboard
```
