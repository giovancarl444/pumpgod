import { describe, expect, it } from 'vitest';
import { Api } from 'telegram';
import { parseHtml } from '../src/telegram/html';
import { renderPublicCall, type RenderOptions } from '../src/format/call';
import type { Signal } from '../src/types';

describe('parseHtml', () => {
  it('strips tags and offsets entities against the plain text', () => {
    const { text, entities } = parseHtml('hello <b>world</b>');
    expect(text).toBe('hello world');
    expect(entities).toHaveLength(1);
    expect(entities[0]).toBeInstanceOf(Api.MessageEntityBold);
    expect(entities[0]!.offset).toBe(6);
    expect(entities[0]!.length).toBe(5);
  });

  it('counts emoji as UTF-16 code units, matching Telegram offsets', () => {
    // ⚡ is one code unit, 🚀 is two — get this wrong and every entity after an emoji shifts.
    const { text, entities } = parseHtml('🚀 <b>go</b>');
    expect(text).toBe('🚀 go');
    expect(entities[0]!.offset).toBe(3);
    expect(text.slice(entities[0]!.offset, entities[0]!.offset + entities[0]!.length)).toBe('go');
  });

  it('handles nesting and links', () => {
    const { text, entities } = parseHtml('<b>bold <i>both</i></b> <a href="https://x.com">link</a>');
    expect(text).toBe('bold both link');
    const link = entities.find((e) => e instanceof Api.MessageEntityTextUrl) as Api.MessageEntityTextUrl;
    expect(link.url).toBe('https://x.com');
    expect(text.slice(link.offset, link.offset + link.length)).toBe('link');
  });

  it('unescapes entities so a token name with & renders correctly', () => {
    const { text } = parseHtml('<b>Tom &amp; Jerry</b>');
    expect(text).toBe('Tom & Jerry');
  });

  it('ignores an unmatched closing tag rather than corrupting offsets', () => {
    const { text, entities } = parseHtml('plain </b> text');
    expect(text).toBe('plain  text');
    expect(entities).toHaveLength(0);
  });

  it('keeps code spans exact — the contract address must survive verbatim', () => {
    const ca = '0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90';
    const { text, entities } = parseHtml(`CA <code>${ca}</code>`);
    const code = entities.find((e) => e instanceof Api.MessageEntityCode)!;
    expect(text.slice(code.offset, code.offset + code.length)).toBe(ca);
  });
});

function signalFixture(): Signal {
  return {
    id: 'test',
    source: { id: 'soaps', label: 'Soaps Gems', mode: 'review', enabled: true },
    chatId: '1',
    messageId: 1,
    rawText: '',
    confirmations: ['soaps'],
    ageSec: 0,
    stale: false,
    risk: { level: 'clear', flags: [] },
    timings: { messageUnix: 0, recvAt: 0, parsedAt: 1, wallClockMs: 0 },
    call: {
      token: {
        address: '0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
        kind: 'evm',
        chain: 'robinhood',
        origin: 'labelled',
        confidence: 1,
      },
      pairAddress: '0x3626904443af56d0dcd4069add190b8dbe0c3006',
      name: 'Troll in Hood',
      ticker: 'TROLL',
      stats: { marketCapUsd: 36270, liquidityUsd: 16910, volumeUsd: 26410, ageText: '4h' },
      candidates: [],
    },
  };
}

function opts(over: Partial<RenderOptions> = {}): RenderOptions {
  return {
    footer: 'NFA · DYOR',
    showSource: false,
    tradeUrlSol: 'https://axiom.trade/t/{address}',
    tradeUrlEvm: '',
    referralLabel: 'Trade these faster',
    ...over,
  };
}

describe('renderPublicCall', () => {
  it('produces a message whose entities line up with the rendered text', () => {
    const html = renderPublicCall(signalFixture(), opts());
    const { text, entities } = parseHtml(html);

    expect(text).toContain('PUMPGOD CALL');
    expect(text).toContain('Troll in Hood ($TROLL)');
    expect(text).toContain('MC $36.3K');
    expect(text).toContain('0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90');
    expect(text).not.toContain('<');

    const code = entities.find((e) => e instanceof Api.MessageEntityCode)!;
    expect(text.slice(code.offset, code.offset + code.length)).toBe(
      '0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
    );

    for (const e of entities) {
      expect(e.offset).toBeGreaterThanOrEqual(0);
      expect(e.offset + e.length).toBeLessThanOrEqual(text.length);
    }
  });

  it('hides the source group unless explicitly enabled', () => {
    const hidden = renderPublicCall(signalFixture(), opts({ footer: '' }));
    expect(hidden).not.toContain('Soaps Gems');
    const shown = renderPublicCall(signalFixture(), opts({ footer: '', showSource: true }));
    expect(shown).toContain('Soaps Gems');
  });

  it('carries the referral link only when one is configured', () => {
    expect(renderPublicCall(signalFixture(), opts())).not.toContain('href="https://axiom.trade/@');
    const withRef = renderPublicCall(signalFixture(), opts({ referralUrl: 'https://axiom.trade/@pumpgod' }));
    expect(withRef).toContain('https://axiom.trade/@pumpgod');
    expect(withRef).toContain('Trade these faster');
  });
});
