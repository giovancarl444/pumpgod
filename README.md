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
7. **Run**: `npm run dev`.

`LIVE=false` is the default. Calls are parsed, staged and logged but never published, so
you can watch it work for a day before it can embarrass you. Flip to `LIVE=true` when the
hit rate looks right.

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

Per source you can set `minMarketCapUsd` / `maxMarketCapUsd` (skip what is already too big to
move), `chains` (only the chains you can actually trade), and `mute`.

Dedupe is global: the same contract from a second group inside `DEDUPE_TTL_SEC` does not
double-post, it is recorded as a confirmation and shown as `2× confirmed`.

## Operating it

```bash
npm run dev              # run it
npm run bench            # parser latency
npm run bench -- --network   # add send round-trip (posts probes to the war room)
npm run replay           # re-run the journal through the current parser
npm test                 # parser + message rendering
```

Everything the bot sees is journalled to `data/journal-YYYY-MM-DD.jsonl`. That file is how
you answer "which group is actually worth following" — and `replay` is how you check a
parser change against real traffic instead of guesses.

## Roadmap

**Phase 1 (this)** — track groups, relay what we like, measure everything.

**Phase 2 — stop being second.** Relaying another group is by definition behind them.
The edge is detecting on-chain: new pool creation on Solana/Base via a geyser or mempool
feed, which puts us ahead of every group we currently follow rather than behind them.
The journal from phase 1 is what tells us which signals are worth acting on.

**Phase 3 — distribution.** X and TikTok: auto-generated recap videos of calls that ran,
rendered from the same journal. Remotion is a React renderer for video, which is why this is
a TypeScript codebase.

## Layout

```
src/
  parse/      address extraction, chain inference, stat fields — pure and synchronous
  telegram/   MTProto client, raw-update ingest, fast send, HTML→entity compiler
  pipeline/   routing, dedupe, enrichment
  format/     message rendering
  metrics/    latency histograms
  store/      journal (buffered, off the hot path)
scripts/      login, dialogs, bench, replay
```
