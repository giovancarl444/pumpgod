import { describe, expect, it } from 'vitest';

import type { AgentDeps, Ask } from '../src/agent/agent';
import { createAgent } from '../src/agent/agent';
import { classify } from '../src/agent/intent';
import type { CompetitionConfig } from '../src/config';
import type { TrackedCall } from '../src/track/tracker';

const COMPETITION: CompetitionConfig = { enabled: false, picksPerDay: 1, minSample: 5, size: 10 };

function call(over: Partial<TrackedCall> = {}): TrackedCall {
  return {
    key: `manual:solana:${Math.random().toString(36).slice(2)}`,
    sourceId: 'manual',
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    outcome: 'called',
    calledAt: Date.now() - 3_600_000,
    lastSeenAt: Date.now(),
    ...over,
  } as TrackedCall;
}

function agent(over: Partial<AgentDeps> = {}) {
  return createAgent({
    calls: () => [],
    competition: COMPETITION,
    ...over,
  });
}

function dm(text: string, userId = 'u1'): Ask {
  return { text, userId, chatId: 'c1', surface: 'dm', addressed: true };
}

function group(text: string, addressed = true, userId = 'u1'): Ask {
  return { text, userId, chatId: 'g1', surface: 'group', addressed };
}

/**
 * The boundary is the reason this thing is shippable at all, so it is tested first and tested
 * hardest. A regression anywhere else in the file is a worse answer; a regression here is a bot
 * telling a stranger to buy something.
 */
describe('the line it never crosses', () => {
  const forbidden = [
    'should i buy this',
    'is this a good entry?',
    'wen moon',
    'will it pump',
    'thoughts on this coin',
    'what do you think of $WIF',
    'is it too late',
    'price target?',
    'should i ape',
    'is this a rug',
    'is this safe',
    'do i sell',
    'worth buying?',
    'gonna x10?',
  ];

  for (const question of forbidden) {
    it(`refuses "${question}"`, () => {
      expect(classify(question)).toBe('advice');
      const reply = agent().ask(dm(question))?.text;
      expect(reply).toMatch(/will not tell you whether a coin is going to go up/i);
    });
  }

  it('refuses the whole message when a forbidden question is smuggled in behind a fair one', () => {
    // Answering the safe half reads as ducking the other, and asking again in a different shape
    // then works. So the refusal takes the whole message.
    const reply = agent().ask(dm('gm, how did you do this week? also should i buy this one'))?.text;
    expect(reply).toMatch(/will not tell you/i);
    expect(reply).not.toMatch(/median peak/i);
  });

  it('still answers a membership question that happens to contain "worth it"', () => {
    // The advice patterns are deliberately generous, which claims this sentence unless it is
    // exempted. Exempted rather than the pattern weakened: the pattern guards more than this.
    expect(classify('is the membership worth it')).toBe('membership');
  });
});

describe('what it says about our record', () => {
  it('quotes numbers read from the tracker, not from anywhere else', () => {
    const calls = [
      call({ entryPriceUsd: 1, athPriceUsd: 12, lastPriceUsd: 3, ticker: 'AAA' }),
      call({ entryPriceUsd: 1, athPriceUsd: 3, lastPriceUsd: 0.4, ticker: 'BBB' }),
      call({ entryPriceUsd: 1, athPriceUsd: 1.1, lastPriceUsd: 1.05, ticker: 'CCC' }),
    ];
    const reply = agent({ calls: () => calls }).ask(dm('what is your track record'))!.text;

    expect(reply).toContain('3</b> call');
    expect(reply).toContain('2 hit 2x');
    expect(reply).toContain('1 hit 10x');
    expect(reply).toContain('of 3 we could price');
  });

  it('volunteers the worst call inside the record, without being asked for it', () => {
    const calls = [
      call({ entryPriceUsd: 1, athPriceUsd: 12, lastPriceUsd: 3, ticker: 'AAA' }),
      call({ entryPriceUsd: 1, athPriceUsd: 1.2, lastPriceUsd: 0.2, ticker: 'DOWN' }),
    ];
    expect(agent({ calls: () => calls }).ask(dm('how have you done'))!.text).toContain('DOWN');
  });

  it('never quotes the best call without the denominator next to it', () => {
    // A best call on its own is the exact shape of every fake track record in this space.
    const calls = [
      call({ entryPriceUsd: 1, athPriceUsd: 40, lastPriceUsd: 20, ticker: 'BIG' }),
      call({ entryPriceUsd: 1, athPriceUsd: 1.1, lastPriceUsd: 0.5, ticker: 'MEH' }),
    ];
    const reply = agent({ calls: () => calls }).ask(dm('what was your best call'))!.text;
    expect(reply).toContain('BIG');
    expect(reply).toContain('one call out of 2');
  });

  it('names the calls it could not price rather than letting them read as losses', () => {
    const calls = [
      call({ entryPriceUsd: 1, athPriceUsd: 3, lastPriceUsd: 2, ticker: 'AAA' }),
      call({ ticker: 'NOPRICE' }),
    ];
    expect(agent({ calls: () => calls }).ask(dm('stats'))!.text).toContain('1 we could not price');
  });

  it('flags a thin sample itself instead of quoting a rate as if it meant something', () => {
    const calls = [call({ entryPriceUsd: 1, athPriceUsd: 9, lastPriceUsd: 9, ticker: 'AAA' })];
    expect(agent({ calls: () => calls }).ask(dm('hit rate?'))!.text).toMatch(/small sample/i);
  });

  it('says there is no record rather than rendering an empty one', () => {
    expect(agent().ask(dm('track record'))!.text).toMatch(/no published calls/i);
  });

  it('counts only published calls, so a shadow or member pick can never reach an answer', () => {
    const calls = [
      call({ entryPriceUsd: 1, athPriceUsd: 2, lastPriceUsd: 2, ticker: 'OURS' }),
      call({ outcome: 'shadow', entryPriceUsd: 1, athPriceUsd: 90, lastPriceUsd: 90, ticker: 'THEIRS' }),
      call({ outcome: 'member', entryPriceUsd: 1, athPriceUsd: 80, lastPriceUsd: 80, ticker: 'MEMBER' }),
    ];
    const reply = agent({ calls: () => calls }).ask(dm('best call'))!.text;
    expect(reply).toContain('OURS');
    expect(reply).not.toContain('THEIRS');
    expect(reply).not.toContain('MEMBER');
  });
});

describe('what it will not claim exists', () => {
  it('does not invent a paid tier before there is one', () => {
    const reply = agent().ask(dm('how much is membership'))!.text;
    expect(reply).toMatch(/no paid tier/i);
    expect(reply).not.toMatch(/stars/i);
  });

  it('describes the paid tier in the terms it was actually configured with', () => {
    const reply = agent({ membership: { priceStars: 500, leadSeconds: 60 } }).ask(dm('membership price'))!.text;
    expect(reply).toContain('500');
    expect(reply).toContain('1 minute');
  });

  it('does not advertise a competition that is switched off', () => {
    expect(agent().ask(dm('how do i enter the competition'))!.text).toMatch(/not running/i);
  });

  it('says it does not know, rather than reaching for the nearest answer', () => {
    expect(agent().ask(dm('what is the airdrop schedule for arbitrum'))!.text).toMatch(/don't know/i);
  });
});

describe('when it speaks at all', () => {
  it('says nothing in a group unless it was addressed', () => {
    expect(agent().ask(group('what is your track record', false))).toBeUndefined();
    expect(agent().ask(group('what is your track record', true))).toBeDefined();
  });

  it('ignores a bare contract address in a group', () => {
    // Somebody shilling. Any answer at all puts our name under their coin.
    expect(agent().ask(group('So11111111111111111111111111111111111111112'))).toBeUndefined();
  });

  it('does not introduce itself every time somebody says gm in a group', () => {
    expect(agent().ask(group('gm'))).toBeUndefined();
    expect(agent().ask(dm('gm'))!.text).toMatch(/pumpgod/i);
  });

  it('goes quiet rather than telling somebody off for asking too much', () => {
    const bot = agent();
    for (let i = 0; i < 6; i++) expect(bot.ask(dm('track record'))).toBeDefined();
    expect(bot.ask(dm('track record'))).toBeUndefined();
  });

  it('caps one person without silencing the group', () => {
    const bot = agent();
    for (let i = 0; i < 6; i++) bot.ask(group('track record', true, 'loud'));
    expect(bot.ask(group('track record', true, 'loud'))).toBeUndefined();
    expect(bot.ask(group('track record', true, 'someone-else'))).toBeDefined();
  });

  it('lets the window expire rather than counting for the life of the process', () => {
    let clock = 0;
    const bot = agent({ now: () => clock, windowMs: 1000 });
    for (let i = 0; i < 6; i++) bot.ask(dm('track record'));
    expect(bot.ask(dm('track record'))).toBeUndefined();
    clock += 1001;
    expect(bot.ask(dm('track record'))).toBeDefined();
  });
});

describe('the things worth being concrete about', () => {
  it('names the specific check rather than claiming thorough research', () => {
    const reply = agent().ask(dm('how do you pick coins'))!.text;
    expect(reply).toMatch(/freeze authority/i);
    expect(reply).toMatch(/can the owner stop you selling/i);
  });

  it('answers "why should I trust you" by telling people to go and check', () => {
    const reply = agent().ask(dm('why should i trust you'))!.text;
    expect(reply).toMatch(/check it yourself|don't take my word/i);
  });
});
