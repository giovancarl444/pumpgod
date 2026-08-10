import { afterEach, describe, expect, it } from 'vitest';
import { loadPresentation } from '../src/config';

const KEY = 'CHAINS';
const original = process.env[KEY];

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
});

describe('CHAINS', () => {
  // The default is the whole promise of the current phase. Widening it should be a decision
  // someone typed out, not something that happens because a default drifted.
  it('ships solana-only', () => {
    delete process.env[KEY];
    expect(loadPresentation().chains).toEqual(['solana']);
  });

  it('reads a list, accepting the short names people actually write', () => {
    process.env[KEY] = 'solana, bsc ,eth';
    expect(loadPresentation().chains).toEqual(['solana', 'bsc', 'ethereum']);
  });

  it('treats "all" as no restriction', () => {
    process.env[KEY] = 'all';
    expect(loadPresentation().chains).toEqual([]);
  });

  // A typo that silently drops an entry would widen or narrow the gate without saying so,
  // and the failure would show up as calls quietly not appearing.
  it('refuses a chain it does not recognise rather than skipping it', () => {
    process.env[KEY] = 'solana,solaan';
    expect(() => loadPresentation()).toThrow(/solaan/);
  });
});
