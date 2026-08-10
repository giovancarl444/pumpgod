import { describe, expect, it } from 'vitest';
import { parseCall, looksLikeCall } from '../src/parse';
import { parseMoney } from '../src/parse/fields';
import { dexScreenerUrl } from '../src/parse/chains';

describe('dexScreenerUrl', () => {
  it('links straight to the chart when we parsed a pool address', () => {
    // Byte-identical to the chart link the source group posted in the sample message,
    // which is where the format is confirmed from.
    expect(dexScreenerUrl('robinhood', '0x3626904443af56d0dcd4069add190b8dbe0c3006', '0xa206')).toBe(
      'https://dexscreener.com/robinhood/0x3626904443af56d0dcd4069add190b8dbe0c3006',
    );
  });

  it('falls back to search rather than risk a 404', () => {
    expect(dexScreenerUrl('base', undefined, '0xa206')).toContain('search?q=0xa206');
    expect(dexScreenerUrl('unknown', '0xpair', '0xa206')).toContain('search?q=0xa206');
  });
});

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

  // Found by `npm run drill`, which posts a call with a random mint every run. Base58 can
  // spell "lp", "ca" and "age", so every short label had to match on a word boundary — the
  // suffix of a mint was being read as a pool address, and the Chart link followed it.
  it('does not read a label out of the middle of an address', () => {
    const call = parseCall('CA: F1Lp7ofUfn6FJaqBzi8eVd5sF1KCRz8rAtojtZnM7Ab\nMarket Cap: $84.20K');
    expect(call!.token.address).toBe('F1Lp7ofUfn6FJaqBzi8eVd5sF1KCRz8rAtojtZnM7Ab');
    expect(call!.token.confidence).toBe(1);
    expect(call!.pairAddress).toBeUndefined();
    expect(call!.candidates).toHaveLength(1);
    expect(call!.stats.marketCapUsd).toBe(84_200);
  });

  it('does not read a token age out of the middle of an address', () => {
    const call = parseCall('CA: C6NEGP7TumUTm7kU2X5dvA4age8Yc2fjZCpjrJpX7Ab\nToken Age: 3h');
    expect(call!.stats.ageText).toBe('3h');
  });

  it('still reads the labels when they are real', () => {
    const text = [
      'CA: 5TokEnTokEnTokEnTokEnTokEnTokEnTokEnTokEnTok',
      'LP: 9pooPpooPpooPpooPpooPpooPpooPpooPpooPpooPpoo',
      'Price: $0.00042 · Token Age: 2h 30m',
    ].join('\n');
    const call = parseCall(text);
    expect(call!.token.address).toBe('5TokEnTokEnTokEnTokEnTokEnTokEnTokEnTokEnTok');
    expect(call!.pairAddress).toBe('9pooPpooPpooPpooPpooPpooPpooPpooPpooPpooPpoo');
    expect(call!.stats.priceUsd).toBe(0.00042);
    expect(call!.stats.ageText).toBe('2h 30m');
  });
});
