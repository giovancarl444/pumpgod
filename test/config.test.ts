import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, loadPresentation } from '../src/config';

const KEY = 'CHAINS';
const original = process.env[KEY];

const CREDS = ['TG_BOT_TOKEN', 'TG_SESSION', 'TG_API_ID', 'TG_API_HASH'] as const;
const originalCreds = Object.fromEntries(CREDS.map((k) => [k, process.env[k]]));

afterEach(() => {
  if (original === undefined) delete process.env[KEY];
  else process.env[KEY] = original;
  for (const k of CREDS) {
    const v = originalCreds[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

/**
 * The first message anybody sees, and for a while it named the wrong half. With nothing set,
 * `required` reached TG_API_ID first and sent people to my.telegram.org for a developer app and
 * a code to their phone — to publish a card, which needs a token pasted from a chat window.
 */
describe('starting with no credentials', () => {
  const clear = () => CREDS.forEach((k) => delete process.env[k]);

  it('offers the bot before the account, and asks for neither by name', () => {
    clear();
    expect(() => loadConfig()).toThrow(/npm run setup/);
    expect(() => loadConfig()).toThrow(/bot token/i);
    expect(() => loadConfig()).not.toThrow(/TG_API_ID/);
  });

  it('does not ask a bot for the credentials only an account needs', () => {
    clear();
    process.env.TG_BOT_TOKEN = '123:abc';
    expect(loadConfig().botToken).toBe('123:abc');
  });

  // The account path still needs them, and saying so early beats a login that half-works.
  it('still requires the developer app when an account is the only credential', () => {
    clear();
    process.env.TG_SESSION = 'sess';
    expect(() => loadConfig()).toThrow(/TG_API_ID/);
  });
});
