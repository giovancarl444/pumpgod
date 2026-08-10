# Things only you can do

Everything here needs a human in Telegram, a browser, or a phone. None of it is code, and
none of it can be done from this repo. Work down it in order — the first group matters
before the next real call goes out, the rest can wait.

---

## Before the next live call

### 1. Get the real topic id

`PUMPGOD_TOPIC=291` in `.env` is a **message** id, not a topic id. They look identical and
Telegram never complains about the difference: a wrong topic id doesn't error, it just
quietly drops the card into General.

**Do:** type `/signal <any address>` inside the signals topic while the bot is running. The
log prints the real thread id. Put that number in `PUMPGOD_TOPIC`.

### 2. Point the war room somewhere

`WAR_ROOM_CHAT` is empty, so every rejection — `✗ that is an EVM address`, `✗ no liquidity` —
posts **publicly in the channel**. Members see the bot arguing with you.

**Do:** make a private group, add the bot as an admin, and put that group's id in
`WAR_ROOM_CHAT`. If it has topics, set `WAR_ROOM_TOPIC` the same way as step 1.

### 3. Put a referral code on the money

`REFERRAL_URL` is empty and `TRADE_URL_SOL` has no ref code in it. Every call published so
far earns nothing, and **that cannot be backfilled** — attribution happens when someone signs
up through the link, so a call that went out without one is revenue that never existed.

**Do:** get your referral link from whichever terminal you want people using, put it in
`REFERRAL_URL`, and put the ref parameter into the `TRADE_URL_SOL` template.

### 4. Revoke the bot token

The token was pasted in plain text during a chat session, which means it should be treated as
public. Anyone holding it owns the bot completely — they can post as pumpgod, in your channel.

**Do:** `/revoke` in @BotFather once you're done testing, then put the new token in `.env`.
It never goes in the repo.

---

## When there is a record worth showing

### 5. Pin the track record

The pinned message updates itself forever after, but creating it is a one-time, loud act —
it notifies the channel and replaces whatever is pinned now. Right now the record is two
BONK test calls, so there is nothing worth pinning yet.

**Do:** after roughly ten real calls, run `npm run scoreboard` to preview it, then
`npm run scoreboard -- --pin` to post and pin it. Once only.

### 6. Turn on the X feed

Four credentials from developer.x.com → your app → Keys and tokens.

**Do:** grant **Read AND Write**, then **regenerate the access token pair afterwards** — a
pair issued before the Write permission will 403 on every post, and the error doesn't say
why. Put all four in `.env`. `npm run recap` previews the feed without posting.

---

## To unlock watching rival groups

This is the biggest unlock in the whole plan and it is blocked entirely on you. A bot can
only see chats an admin **added** it to. That is a Telegram platform rule, not something in
our code, so pumpgod can never read a rival group from the bot account.

### 7. Log in a reader account

**Do:** `npm run login`, on a **separate Telegram account** — not the bot, not your personal
one. That account joins rival groups and is the one that eventually gets banned. The bot owns
the channel and has to stay clean, which is why they must never be the same account.

Type the phone number into the prompt yourself. Never paste it into a command for me to run —
that sends a real SMS to a real phone.

### 8. List the groups to watch

**Do:** fill `config/sources.json` with the rival groups, **every one of them in
`"mode": "shadow"`**. Shadow records what a group would have made us and publishes nothing.

### 9. Wait, then promote on the numbers

**Do:** after ~20 calls from a source, run `npm run scorecard`. It ranks each group on median
peak multiple, hit rate and rug rate. Move the ones that earn it to `review`, and only the
best to `auto`.

Twenty is not arbitrary — below it a hit rate is noise, and any sharp reader knows that.
Being fast at copying a bad group is worth nothing.

---

## Never

- **Never test against the public channel.** A flashed message is visible to members even if
  it's deleted a second later. Use the war room.
- **Never commit `.env`, `config/sources.json`, or anything under `data/`.** They hold
  credentials and the outcome record.
- `TG_SESSION` is a full login for the reader account. Treat it exactly like a password.
