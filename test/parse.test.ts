import { describe, expect, it } from 'vitest';
import { parseCall, looksLikeCall } from '../src/parse';
import { parseMoney } from '../src/parse/fields';

describe('parseMoney', () => {
  it('handles suffixes, commas and dollar signs', () => {
    expect(parseMoney('$36.27K')).toBe(36270);
    expect(parseMoney('1,234')).toBe(1234);
    expect(parseMoney('2.1m')).toBe(2_100_000);
    expect(parseMoney('$1.05B')).toBe(1_050_000_000);
    expect(parseMoney('nope')).toBeUndefined();
  });
});

describe('looksLikeCall', () => {
  it('rejects ordinary chatter fast', () => {
    expect(looksLikeCall('gm frens wen moon')).toBe(false);
    expect(looksLikeCall('this one is going to run')).toBe(false);
  });
});

describe('parseCall — real message shapes', () => {
  it('picks the labelled CA over the pair address in the DexScreener link', () => {
    const text = [
      'Soaps Gems 💎 (https://t.me/pumpgod_fun) Troll in Hood | TROLL',
      'CA: 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
      '📊 Market Cap: $36.27K 🌐 Robinhood Chain 💧 Liquidity: $16.91K 📈 Volume: $26.41K ⏰ Token Age: 4h DexScreener (https://dexscreener.com/robinhood/0x3626904443af56d0dcd4069add190b8dbe0c3006)',
    ].join('\n');

    const call = parseCall(text);
    expect(call).not.toBeNull();
    expect(call!.token.address).toBe('0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90');
    expect(call!.token.origin).toBe('labelled');
    expect(call!.token.chain).toBe('robinhood');
    expect(call!.pairAddress).toBe('0x3626904443af56d0dcd4069add190b8dbe0c3006');
    expect(call!.ticker).toBe('TROLL');
    expect(call!.stats.marketCapUsd).toBe(36270);
    expect(call!.stats.liquidityUsd).toBe(16910);
    expect(call!.stats.volumeUsd).toBe(26410);
    expect(call!.stats.ageText).toBe('4h');
  });

  it('strips the source group branding link when reading the name', () => {
    // How the same message actually arrives over MTProto: the URL lives in an entity.
    const call = parseCall({
      text: 'Soaps Gems 💎 Troll in Hood | TROLL\nCA: 0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
      entities: [{ offset: 0, length: 13, url: 'https://t.me/pumpgod_fun' }],
    });
    expect(call!.name).toBe('Troll in Hood');
    expect(call!.ticker).toBe('TROLL');
  });

  it('reads a bare solana mint with a $ticker', () => {
    const call = parseCall('🚀 $WIF looking ready\n7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr');
    expect(call!.token.address).toBe('7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr');
    expect(call!.token.chain).toBe('solana');
    expect(call!.ticker).toBe('WIF');
  });

  it('pulls the mint out of a pump.fun link', () => {
    const call = parseCall('new one https://pump.fun/coin/8xJ2p5vNqR3kLmT7wYcZaB4dEfGhJkMnPqRsTuVwXyZa');
    expect(call!.token.address).toBe('8xJ2p5vNqR3kLmT7wYcZaB4dEfGhJkMnPqRsTuVwXyZa');
    expect(call!.token.chain).toBe('solana');
  });

  it('understands entity-only links', () => {
    const call = parseCall({
      text: 'Chart',
      entities: [
        { offset: 0, length: 5, url: 'https://dexscreener.com/base/0x1111111111111111111111111111111111111111' },
      ],
    });
    expect(call!.token.chain).toBe('base');
  });

  it('ignores burn addresses', () => {
    const call = parseCall('burned to 0x000000000000000000000000000000000000dEaD');
    expect(call).toBeNull();
  });

  it('ignores plain chatter and telegram invite links', () => {
    expect(parseCall('join https://t.me/somegroup for more')).toBeNull();
    expect(parseCall('what do we think about this one')).toBeNull();
  });

  it('prefers a labelled contract even when a chart link appears first', () => {
    const text = [
      'Chart: https://dexscreener.com/solana/9pooLpooLpooLpooLpooLpooLpooLpooLpooLpooLpoo',
      'Contract Address: 5TokEnTokEnTokEnTokEnTokEnTokEnTokEnTokEnTok',
    ].join('\n');
    const call = parseCall(text);
    expect(call!.token.address).toBe('5TokEnTokEnTokEnTokEnTokEnTokEnTokEnTokEnTok');
    expect(call!.token.origin).toBe('labelled');
  });
});
