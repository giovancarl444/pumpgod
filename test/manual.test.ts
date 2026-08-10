import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCommand, resolveManualCall } from '../src/pipeline/manual';

const TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL = '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9';

function pair(over: Record<string, unknown> = {}) {
  return {
    chainId: 'solana',
    pairAddress: POOL,
    priceUsd: '0.0000246',
    marketCap: 200_000,
    liquidity: { usd: 40_000 },
    volume: { h24: 90_000 },
    baseToken: { address: TOKEN, name: 'Bonk', symbol: 'bonk' },
    pairCreatedAt: Date.now() - 3 * 60_000,
    ...over,
  };
}

/** Serves a canned response per URL fragment, so a test states exactly which hops it expects. */
function dex(routes: Array<[string, unknown]>) {
  const seen: string[] = [];
  const fetchMock = vi.fn(async (url: string) => {
    seen.push(url);
    const hit = routes.find(([fragment]) => url.includes(fragment));
    return { ok: true, json: async () => ({ pairs: hit ? hit[1] : [] }) } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseCommand', () => {
  it('takes the address after the command word', () => {
    expect(parseCommand(`call ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`/call ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`CALL: ${TOKEN}`)).toBe(TOKEN);
  });

  it('ignores an address discussed without the command word', () => {
    // The war room is a chat. Publishing whatever anyone pastes there has no undo.
    expect(parseCommand(`what do we think about ${TOKEN}`)).toBeUndefined();
    expect(parseCommand(TOKEN)).toBeUndefined();
  });

  it('ignores the command word with nothing after it', () => {
    expect(parseCommand('call')).toBeUndefined();
  });

  it('does not fire on a word that merely starts with call', () => {
    expect(parseCommand('calling it here')).toBeUndefined();
  });
});

describe('resolveManualCall', () => {
  it('resolves a bare token address in one hop', async () => {
    const seen = dex([[`/tokens/${TOKEN}`, [pair()]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.call.token.address).toBe(TOKEN);
    expect(out.call.ticker).toBe('BONK');
    expect(out.call.token.chain).toBe('solana');
    expect(seen).toHaveLength(1);
  });

  it('trusts an address a human typed out — nothing is more deliberate', async () => {
    dex([[`/tokens/${TOKEN}`, [pair()]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.token.origin).toBe('labelled');
    expect(out.call.token.confidence).toBe(1);
  });

  it('sums liquidity across pools, because market cap is a whole-token number', async () => {
    // One pool of $40K against a $200M cap reads as unbacked; four of them do not.
    dex([
      [
        `/tokens/${TOKEN}`,
        [
          pair({ liquidity: { usd: 40_000 }, volume: { h24: 10_000 } }),
          pair({ pairAddress: 'p2', liquidity: { usd: 30_000 }, volume: { h24: 5_000 } }),
          pair({ pairAddress: 'p3', liquidity: { usd: 20_000 }, volume: { h24: 5_000 } }),
        ],
      ],
    ]);

    const out = await resolveManualCall(TOKEN, 2000);
    if (!out.ok) throw new Error(out.reason);
    expect(out.call.stats.liquidityUsd).toBe(90_000);
    expect(out.call.stats.volumeUsd).toBe(20_000);
    // The deepest pool is still what gets linked, since that is what a buyer trades against.
    expect(out.call.pairAddress).toBe(POOL);
  });

  it('ignores pools for a different token that merely share the string', async () => {
    // Search really does return same-string tokens on other chains; the token endpoint is
    // filtered on exact address for the same reason.
    dex([
      [
        `/tokens/${TOKEN}`,
        [pair(), pair({ chainId: 'fogo', baseToken: { address: 'OTHER', symbol: 'nope' }, liquidity: { usd: 9e9 } })],
      ],
    ]);

    const out = await resolveManualCall(TOKEN, 2000);
    if (!out.ok) throw new Error(out.reason);
    expect(out.call.ticker).toBe('BONK');
    expect(out.call.stats.liquidityUsd).toBe(40_000);
  });

  it('turns a pasted chart link into the token it charts', async () => {
    // A chart URL carries the pool address, so this costs an extra hop to get back to the
    // token — then re-reads it so the aggregate covers every pool, not just the linked one.
    const seen = dex([
      [`/search`, [pair()]],
      [`/tokens/${TOKEN}`, [pair(), pair({ pairAddress: 'p2', liquidity: { usd: 15_000 } })]],
    ]);

    const out = await resolveManualCall(`https://dexscreener.com/solana/${POOL}`, 2000);
    if (!out.ok) throw new Error(out.reason);

    expect(out.call.token.address).toBe(TOKEN);
    expect(out.call.stats.liquidityUsd).toBe(55_000);
    expect(seen.some((u) => u.includes('/search'))).toBe(true);
  });

  it('refuses an address with no pool — there is nothing to trade against', async () => {
    dex([]);
    const out = await resolveManualCall('0x1111111111111111111111111111111111111111', 2000);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('no pool');
  });

  it('refuses text with no address in it', async () => {
    dex([]);
    const out = await resolveManualCall('gm what are we buying', 2000);
    expect(out.ok).toBe(false);
  });

  it('separates a failed lookup from a token that is genuinely not listed', async () => {
    // One is worth retrying and the other is not, so they must not read the same.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response),
    );
    const out = await resolveManualCall(TOKEN, 2000);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('did not answer');
  });
});
