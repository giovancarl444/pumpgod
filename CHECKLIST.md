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

## To sell promotion slots

The code is written and off (`PROMO_ENABLED=false`). Three of these are decisions, not steps.

### 7. Decide whether to open it at all

Selling a slot changes what the channel is. The build makes the honest version the only version
available — the card is headed `📣 PAID PROMOTION`, never wears the pumpgod header, says outright
that we did not pick the coin, and cannot enter the track record by any route. That is the
version that survives someone looking hard at it, and it is also the version that keeps brand
deals possible later.

The dishonest version — paid pumps posted as if they were our own calls — pays more, immediately,
and it is the one thing on this whole roadmap that would make everything else worthless. Every
number we publish is only worth something because it is checkable. One undisclosed paid call and
none of them are.

**Do:** decide. If yes, keep `PROMO_DAILY_LIMIT` small — three a day is already a lot in a feed
people follow for calls.

### 8. Enable payments for the bot

Stars are the only currency a bot may charge in for something delivered inside Telegram. There is
no provider token and no Stripe account; Telegram handles the money.

**Do:** @BotFather → your bot → **Payments** → enable. Without this every invoice fails and the
buyer sees an error instead of a checkout.

### 9. Check what a Star is worth today, then set the price

`PROMO_PRICE_STARS=1150` is the €20 default, but "€20" depends on where the buyer topped up:
roughly **€0.0175 a Star inside the phone app** (Apple and Google take ~30%) and **€0.0122 on the
web**. So 1150 Stars is ≈ €20 on a phone and ≈ €14 on the web. We receive around €13 of it —
the payout rate is a third number again (~$0.013 a Star, less Fragment's 5% to withdraw).

**Do:** check the current rate before the first sale, and treat the payout number as the real
price rather than the sticker. All three move independently.

### 10. Test it on yourself, in a DM

The DM surface is deliberately separate from the command path — a `/signal` sent to the bot by a
stranger must never publish. That gate has a test, but the payment flow has never touched
Telegram's real checkout.

**Do:** with `PROMO_ENABLED=true` and `LIVE=true`, DM the bot `/promote <a real Solana address>`
and pay it yourself. Refunds go through `refundStarPayment`, so the Stars come back. Confirm the
card lands looking like an advert and that `npm run scoreboard` does **not** count it.

---

## To open the call competition

Also written and off (`COMP_ENABLED=false`). This is the growth loop: members DM `/submit
<address>`, the same tracker prices their pick, and `/leaderboard` ranks them on median peak.
Nothing a member submits can reach the channel — that is enforced three separate ways in code
and has its own tests.

### 11. Decide what winning is worth

A leaderboard is not a competition. People will enter a table that costs them nothing exactly
once, and then stop, unless being top of it gets them something.

It does not have to be money — first call of the day published under their handle, a role,
a cut of a promo slot, anything scarce. But it has to be *stated*, and it has to be settled on
a schedule (weekly is the obvious one) or the table has no clock and no drama.

**Do:** decide the prize and the period before turning it on. Changing the rules after people
have picks on the board is the one thing that kills it.

### 12. Test it on yourself, then pin the table

Nobody submits to a bot they don't know accepts submissions, and `/submit` is invisible until
someone says it exists.

**Do:** with `COMP_ENABLED=true`, DM the bot `/submit <a real Solana address>` and confirm you
get a confirmation with the entry market cap, that `/me` shows the pick, and that `npm run
scoreboard` does **not** count it.

Pick something already moving, or nothing else will happen while you watch. If it doubles you
should get a second DM — `🎯 Your pick … hit 2x` — within a minute of it happening. That message
is the competition's entire retention loop, so it is worth seeing once with your own eyes before
you tell anybody the competition exists.

Then `npm run leaderboard` to preview and `npm run leaderboard -- --pin` to post and pin it —
**pin it empty**, before anyone has entered. A table saying "nobody has entered yet, here is how"
is the announcement, and it edits itself from then on. Note that Telegram shows the newest pin
first, so pin this *before* the track record if you want the record on top.

Say in the announcement that picks are private and only the leaderboard is public — people are
far more willing to enter when a bad pick isn't posted under their name. State the prize and the
period from step 11 in the same message.

---

## To unlock watching rival groups

This is the biggest unlock in the whole plan and it is blocked entirely on you. A bot can
only see chats an admin **added** it to. That is a Telegram platform rule, not something in
our code, so pumpgod can never read a rival group from the bot account.

### 13. Log in a reader account

**Do:** `npm run login`, on a **separate Telegram account** — not the bot, not your personal
one. That account joins rival groups and is the one that eventually gets banned. The bot owns
the channel and has to stay clean, which is why they must never be the same account.

Type the phone number into the prompt yourself. Never paste it into a command for me to run —
that sends a real SMS to a real phone.

### 14. List the groups to watch

**Do:** fill `config/sources.json` with the rival groups, **every one of them in
`"mode": "shadow"`**. Shadow records what a group would have made us and publishes nothing.

### 15. Wait, then promote on the numbers

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
