import { describe, expect, it } from 'vitest';
import { Api } from 'telegram';
import { parseHtml } from '../src/telegram/html';
import { callButtons, renderPublicCall, type RenderOptions } from '../src/format/call';
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

    expect(text).toContain('PUMPGOD');
    expect(text).toContain('Troll in Hood | TROLL');
    expect(text).toContain('📊 Market Cap: $36.3K');
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

  // The whole point of the redesign: one fact per line, so the reader finds the number they
  // want by its icon. A regression here reads as "we quietly went back to the wall of text".
  it('gives each stat its own line, and the address a line of its own under CA:', () => {
    const { text } = parseHtml(renderPublicCall(signalFixture(), opts({ footer: '' })));
    const lines = text.split('\n');

    expect(lines.slice(0, 5)).toEqual([
      'PUMPGOD ⚡',
      'Troll in Hood | TROLL',
      '',
      'CA:',
      '0xa206753eb19D8E3F9Ae3313ADb467BdC2a7a4d90',
    ]);
    expect(lines).toContain('📊 Market Cap: $36.3K');
    expect(lines).toContain('🌐 Robinhood');
    expect(lines).toContain('💧 Liquidity: $16.9K');
    expect(lines).toContain('📈 Volume: $26.4K');
    expect(lines).toContain('⏰ Token Age: 4h');
  });

  // Detail that needs a second read belongs in the war room, not in a signal.
  it('leaves the close-up analysis out', () => {
    const signal = signalFixture();
    signal.call.stats.holders = 412;
    const { text } = parseHtml(renderPublicCall(signal, opts()));

    expect(text).not.toContain('holders');
    expect(text).not.toContain('labelled');
    expect(text).not.toContain('%');
    expect(text).not.toContain('Scan');
  });

  it('counts confirmations only when more than one group called it', () => {
    expect(renderPublicCall(signalFixture(), opts())).not.toContain('confirmed');

    const seconded = signalFixture();
    seconded.confirmations = ['soaps', 'alpha'];
    expect(renderPublicCall(seconded, opts())).toContain('✅ 2× confirmed');
  });

  // A DexScreener search wearing a Buy label is worse than no button — it looks like a swap
  // and is not one. The EVM template ships blank, so this is the default path, not an edge.
  it('drops the Buy link when no terminal is configured for that chain', () => {
    const evm = parseHtml(renderPublicCall(signalFixture(), opts())).text;
    expect(evm).toContain('DexScreener');
    expect(evm).not.toContain('Buy');

    const sol = signalFixture();
    sol.call.token.chain = 'solana';
    expect(parseHtml(renderPublicCall(sol, opts())).text).toContain('DexScreener · Buy');
  });

  it('puts a danger flag above the links, not below them', () => {
    const risky = signalFixture();
    risky.risk = { level: 'danger', flags: [{ code: 'thin', level: 'danger', detail: 'Liquidity is not locked' }] };
    const { text } = parseHtml(renderPublicCall(risky, opts()));

    expect(text.indexOf('Liquidity is not locked')).toBeLessThan(text.indexOf('DexScreener'));
  });

  it('hides the source group unless explicitly enabled', () => {
    const hidden = renderPublicCall(signalFixture(), opts({ footer: '' }));
    expect(hidden).not.toContain('Soaps Gems');
    const shown = renderPublicCall(signalFixture(), opts({ footer: '', showSource: true }));
    expect(shown).toContain('Soaps Gems');
  });

  /**
   * The card's only positive safety claim, and the one place a bug is worse than a crash: a
   * reader who trusts this line and gets a token whose mint was never read has been told
   * something we did not know. Every case here is about which half is *earned*.
   */
  describe('the line a clean screen earns', () => {
    function checked(over: { freezeAuthority?: string; mintAuthority?: string } = {}): Signal {
      const signal = signalFixture();
      signal.call.onchain = { mint: { supply: 1_000_000_000n, decimals: 6, ...over } };
      return signal;
    }

    it('says so when the mint was read and both keys are dead', () => {
      const html = renderPublicCall(checked(), opts());
      expect(html).toContain('mint &amp; freeze revoked');
      expect(html).toContain('liquidity ok');
    });

    it('stays silent about the mint when nobody read it', () => {
      // `chainFlags` returns no flags at all when the chain was never asked — correct for the
      // relay path, but it makes "clear" mean "nothing looked bad", not "we checked". Without
      // this, every relayed call would claim a revocation nobody verified.
      const html = renderPublicCall(signalFixture(), opts());
      expect(html).not.toContain('revoked');
      // The half that *was* measured is still allowed to speak.
      expect(html).toContain('liquidity ok');
    });

    it('claims nothing when a live authority is sitting right there', () => {
      const signal = checked({ freezeAuthority: 'FrEeZe1111111111111111111111111111111111111' });
      signal.risk = { level: 'danger', flags: [{ code: 'freeze-authority', detail: 'freeze authority is live', level: 'danger' }] };
      const html = renderPublicCall(signal, opts());
      expect(html).not.toContain('✅');
    });

    it('does not vouch for depth it could not read', () => {
      const signal = checked();
      delete signal.call.stats.liquidityUsd;
      const html = renderPublicCall(signal, opts());
      expect(html).toContain('mint &amp; freeze revoked');
      expect(html).not.toContain('liquidity ok');
    });

    it('does not call a pool nobody could exit "ok"', () => {
      const signal = checked();
      signal.call.stats.liquidityUsd = 900;
      expect(renderPublicCall(signal, opts())).not.toContain('liquidity ok');
    });
  });

  it('carries the referral link only when one is configured', () => {
    expect(renderPublicCall(signalFixture(), opts())).not.toContain('href="https://axiom.trade/@');
    const withRef = renderPublicCall(signalFixture(), opts({ referralUrl: 'https://axiom.trade/@pumpgod' }));
    expect(withRef).toContain('https://axiom.trade/@pumpgod');
    expect(withRef).toContain('Trade these faster');
  });
});

/**
 * Buttons are bot-only: a user account cannot attach reply markup, and the MTProto transport
 * therefore drops them with no error raised anywhere. So the test that matters is not what the
 * buttons say — it is that the same card is still complete without any of them.
 */
describe('callButtons', () => {
  function sol(): Signal {
    const signal = signalFixture();
    signal.call.token.chain = 'solana';
    return signal;
  }

  it('leads with Buy, because it is the only line on the card that earns anything', () => {
    const signal = sol();
    const [row] = callButtons(signal, opts());
    expect(row!.map((b) => b.text)).toEqual(['⚡ Buy now', '📊 Chart']);
    expect(row![0]!.url).toBe(`https://axiom.trade/t/${signal.call.token.address}`);
  });

  it('never duplicates a link the card does not already carry in its body', () => {
    // The rule the MTProto path depends on. Every button URL has to appear as an anchor too,
    // or the same call posted from the reader account silently loses the way to act on it.
    const signal = sol();
    const options = opts({ referralUrl: 'https://axiom.trade/@pumpgod' });
    const html = renderPublicCall(signal, options);

    for (const button of callButtons(signal, options).flat()) {
      expect(html).toContain(`href="${button.url}"`);
    }
  });

  it('offers no Buy button where there is no terminal, matching the card', () => {
    // Robinhood chain with a blank EVM template: a DexScreener search wearing a Buy label is
    // worse than no button, and worse still as a thumb-sized one.
    const rows = callButtons(signalFixture(), opts());
    expect(rows.flat().map((b) => b.text)).toEqual(['📊 Chart']);
  });

  it('adds the referral row only when one is configured', () => {
    expect(callButtons(sol(), opts())).toHaveLength(1);
    const withRef = callButtons(sol(), opts({ referralUrl: 'https://axiom.trade/@pumpgod' }));
    expect(withRef).toHaveLength(2);
    expect(withRef[1]![0]).toMatchObject({ text: 'Trade these faster', url: 'https://axiom.trade/@pumpgod' });
  });

  it('carries no callback data at all, so nothing needs answering within 10s', () => {
    const rows = callButtons(sol(), opts({ referralUrl: 'https://axiom.trade/@pumpgod' }));
    for (const button of rows.flat()) {
      expect(button.url).toBeTruthy();
      expect(button.data).toBeUndefined();
    }
  });
});
