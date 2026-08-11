import { describe, expect, it } from 'vitest';

import { readCallPost } from '../src/parse/callpost';

const MINT = '7RoRbGq7ncnmoqCsHRzDeaJz7zGcBwvtVaq2uaEfpump';
const OTHER = 'GEcKmoZzCPk1xHDqnwyk8JR2EDGK8vDT6KMHKevTpump';

/**
 * Every string in here was copied out of a real post from a channel on the watchlist. The
 * filter is the one piece of the scraper that cannot be checked by looking at the output — a
 * recap recorded as a call produces a perfectly well-formed row that is simply a lie — so it is
 * pinned against the traffic it was written for rather than against invented examples.
 */
describe('a call, as these channels actually write one', () => {
  it('takes a bare mint under a one-line thought', () => {
    // @culturecalls, the whole message.
    const read = readCallPost(`Also lowcap gamble (potential x)\n\n${MINT}`);
    expect(read).toEqual({ call: true, address: MINT });
  });

  it('takes a structured card with stats and a chart link', () => {
    // @WCTCalls. The chart link resolves to the pool, which must not count as a second coin.
    const read = readCallPost(
      `🎯 $PATE — PATE [SOL]\n\n${MINT}\n\n📊 MC: $42.23M · Liq: $474k · Age: 0d\n` +
        `🔒 mint ✅ · freeze ✅ · LP locked 100% · top10 3%\n` +
        `📈 chart https://dexscreener.com/solana/HgpbxqtHN8uuntiPsmpMGzJUhYLFfpC1H24M5phdYomL`,
    );
    expect(read).toEqual({ call: true, address: MINT });
  });

  it('takes a labelled address', () => {
    expect(readCallPost(`New one, low cap\n\nCA: ${MINT}`)).toEqual({ call: true, address: MINT });
  });
});

/**
 * The expensive mistake. A group's own scoreboard post carries a ticker, a market cap and often
 * a contract address, so it parses as a call and records the coin at the top of a move that has
 * already happened — crediting an entry nobody could take, then charging the whole retrace.
 */
describe('a victory lap, which must never be recorded as a call', () => {
  const laps: Array<[string, string]> = [
    ['a leading multiple', `88X $CATE HIT 85.5M 💎 now at 38.6M 🪙\n\n${MINT}`],
    ['a decimal leading multiple', `10.5X $HMM HIT 7.7M 🔥 now at 6.4M 🔥\n\n${MINT}`],
    ['a call announced after the fact', `9X $NEEGY (SOL) 🪙\n\nCalled in private earlier at 69K and mooned to 600K.\n\n${MINT}`],
    ['congratulations', `$WIF keeps sending, congrats legends\n\n${MINT}`],
    ['a new all-time high', `New ATH for the thinking cat!\n\n${MINT}`],
    ['a journey between two caps', `From 69K to 600K in a day\n\n${MINT}`],
    ['a daily round-up', `🏆 DAILY TOP 10 · last 24h\n🥇 $BOT · 10.9x\n\n${MINT}`],
    ['a weekly recap', `Weekly recap — here is how the week went\n\n${MINT}`],
    ['a multiple measured from the call', `did 12x from our call earlier\n\n${MINT}`],
  ];

  for (const [what, text] of laps) {
    it(`refuses ${what}`, () => {
      expect(readCallPost(text)).toEqual({ call: false, why: 'retrospective' });
    });
  }

  it('refuses a list of coins, however it is worded', () => {
    // Two mints in one post is a summary of calls already made. A group calling two coins at
    // once posts twice, because it wants two entries and two charts.
    expect(readCallPost(`Runners today\n\n${MINT}\n${OTHER}`)).toEqual({
      call: false,
      why: 'many-addresses',
    });
  });
});

describe('what else is on these channels', () => {
  it('ignores chatter with no address in it', () => {
    expect(readCallPost('GM FAM 🐳')).toEqual({ call: false, why: 'no-address' });
  });

  it('ignores an empty post', () => {
    expect(readCallPost('   ')).toEqual({ call: false, why: 'no-address' });
  });

  it('ignores a paid slot, which is somebody else’s coin', () => {
    expect(readCallPost(`Sponsored: check this one out\n\n${MINT}`)).toEqual({
      call: false,
      why: 'promotional',
    });
  });
});

describe('which way it errs', () => {
  it('would rather drop a real call than record a recap', () => {
    // "100x potential" is a genuine call and this filter throws it out, because the same shape
    // is how a scoreboard post opens. That costs one row of sample and keeps every recorded
    // number true; the opposite trade corrupts the numbers themselves.
    expect(readCallPost(`100x potential here\n\n${MINT}`).call).toBe(false);
  });
});
