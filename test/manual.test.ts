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
    expect(parseCommand(`/signal ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`signal ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`call ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`/call ${TOKEN}`)).toBe(TOKEN);
    expect(parseCommand(`CALL: ${TOKEN}`)).toBe(TOKEN);
  });

  // Telegram appends the handle when a command is tapped from a group's autocomplete, so
  // the tapped form has to mean the same thing as the typed one.
  it('accepts the @handle suffix Telegram adds in groups', () => {
    expect(parseCommand(`/signal@realpumpgod_bot ${TOKEN}`)).toBe(TOKEN);
  });

  it('takes a chart link as readily as an address', () => {
    const url = `https://dexscreener.com/solana/${POOL}`;
    expect(parseCommand(`/signal ${url}`)).toBe(url);
  });

  it('ignores an address discussed without the command word', () => {
    // The war room is a chat. Publishing whatever anyone pastes there has no undo.
    expect(parseCommand(`what do we think about ${TOKEN}`)).toBeUndefined();
    expect(parseCommand(TOKEN)).toBeUndefined();
  });

  it('ignores the command word with nothing after it', () => {
    expect(parseCommand('call')).toBeUndefined();
    expect(parseCommand('/signal')).toBeUndefined();
  });

  it('does not fire on a word that merely starts with the command', () => {
    expect(parseCommand('calling it here')).toBeUndefined();
    expect(parseCommand('signalling the group now')).toBeUndefined();
  });

  // Our own published cards come back through ingest as messages from this account. If any
  // of them parsed as a command, the channel would call itself in a loop.
  it('does not fire on our own published card', () => {
    expect(parseCommand(`PUMPGOD ⚡\nTroll in Hood | TROLL\n\nCA:\n${TOKEN}`)).toBeUndefined();
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

  // Fartcoin's name and symbol are both `"Fartcoin "` on the live API, which renders the
  // title as `Fartcoin  | FARTCOIN ` and every reply about it as `$FARTCOIN `.
  it('takes the whitespace a deployer left in the name off the card', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name: 'Fartcoin ', symbol: 'Fartcoin ' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.name).toBe('Fartcoin');
    expect(out.call.ticker).toBe('FARTCOIN');
  });

  it('treats a name that is only whitespace as absent, rather than printing a gap', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name: '   ', symbol: 'BONK' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.name).toBeUndefined();
    expect(out.call.ticker).toBe('BONK');
  });

  // Both of these fields are whatever the deployer typed when they launched the coin, and both
  // of them travel into HTML we send to a room of people who are about to buy something. The
  // launch costs a few dollars, so this is the cheapest attack available on the whole channel.
  it('takes the markup out of a symbol chosen to be markup', async () => {
    const symbol = '<a href="https://evil.example">CLICK</a>';
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name: 'Bonk', symbol } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.ticker).not.toContain('<');
    expect(out.call.ticker).not.toContain('>');
  });

  // U+202E reverses everything printed after it. Next to a contract address that is not a
  // rendering quirk, it is how a string is made to read as something other than what it is.
  it('strips a right-to-left override out of a name', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name: 'Safe‮dnop', symbol: 'BONK' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.name).toBe('Safednop');
  });

  // A card prints the name inline. A newline in it is a line of our message written by someone
  // else — and "✅ Audited by pumpgod" is exactly the line they would write.
  it('flattens a name that tries to add a line to the card', async () => {
    const name = 'Bonk\n✅ Audited by pumpgod';
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name, symbol: 'BONK' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.name).toBe('Bonk ✅ Audited by pumpgod');
  });

  // The field is unbounded and a Telegram message is not, so without a cap a long enough name
  // is a coin that stops the channel from posting at all.
  it('caps a name long enough to break the send', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ baseToken: { address: TOKEN, name: 'A'.repeat(5000), symbol: 'BONK' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.name!.length).toBeLessThanOrEqual(48);
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

  it('carries the coin artwork through, so the card can be posted as a photo', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ info: { imageUrl: 'https://cdn.example/bonk.png' } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    if (!out.ok) throw new Error(out.reason);
    expect(out.call.imageUrl).toBe('https://cdn.example/bonk.png');
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

// Whoever pasted the address is standing there waiting, so a refusal has to say which rule
// it broke. The router drops an off-chain call silently; this path never should.
describe('resolveManualCall with a chain restriction', () => {
  it('publishes a solana coin when solana is what we call', async () => {
    dex([[`/tokens/${TOKEN}`, [pair()]]]);
    const out = await resolveManualCall(TOKEN, 2000, ['solana']);

    expect(out.ok).toBe(true);
  });

  it('rejects an EVM address from its shape alone, without a round trip', async () => {
    // base58 is never an EVM contract and 0x… is never a mint, so the wrong paste — which is
    // the common one while we are solana-only — answers instantly.
    const seen = dex([]);
    const out = await resolveManualCall('0x1111111111111111111111111111111111111111', 2000, ['solana']);

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('EVM address');
    expect(seen).toHaveLength(0);
  });

  it('rejects a coin the market places on a chain the shape could not rule out', async () => {
    // Every EVM chain shares one address format, so `0x…` restricted to base gets past the
    // shape gate and can only be refused once DexScreener says which chain it is really on.
    const evm = '0x1111111111111111111111111111111111111111';
    dex([[`/tokens/${evm}`, [pair({ chainId: 'ethereum', baseToken: { address: evm, symbol: 'x' } })]]]);

    const out = await resolveManualCall(evm, 2000, ['base']);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain('ethereum');
    expect(out.reason).toContain('base');
  });

  it('calls any chain when no restriction is set', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ chainId: 'base' })]]]);
    expect((await resolveManualCall(TOKEN, 2000, [])).ok).toBe(true);
  });
});

// DexScreener serves a token's logo in whatever it was uploaded as. A coin whose profile is
// an animated GIF comes back as megabytes of animation that Telegram will not take as a
// photo — so the call publishes as plain text, having first paid to upload it.
describe('the artwork URL we actually fetch', () => {
  const CDN = 'https://cdn.dexscreener.com/cms/images/abc';

  it('asks for a still frame instead of whatever the logo was uploaded as', async () => {
    dex([[`/tokens/${TOKEN}`, [pair({ info: { imageUrl: `${CDN}?width=800&format=auto` } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.call.imageUrl).toContain('format=png');
    expect(out.call.imageUrl).toContain('width=800');
  });

  it('leaves a plain image link alone, since it speaks no such query language', async () => {
    const plain = 'https://dd.dexscreener.com/ds-data/tokens/solana/bonk.png';
    dex([[`/tokens/${TOKEN}`, [pair({ info: { imageUrl: plain } })]]]);
    const out = await resolveManualCall(TOKEN, 2000);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.call.imageUrl).toBe(plain);
  });
});
