import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parsePreview } from '../src/telegram/webpreview';

/**
 * Saved copies of `t.me/s/<handle>`, exactly as Telegram served them.
 *
 * The scraper's failure mode is silence. Telegram changes this markup on its own schedule, and
 * a parser that has stopped matching returns zero posts — which reads as a quiet week and can
 * go unnoticed for as long as it takes to wonder why the sample never grows. These pages are
 * the only thing that turns that into a red test.
 */
function fixture(name: string): string {
  return readFileSync(resolve(__dirname, `fixtures/preview-${name}.html`), 'utf8');
}

describe('reading a channel the way a browser sees it', () => {
  it('finds every post on the page', () => {
    const posts = parsePreview('WCTCalls', fixture('wctcalls'));
    // A page carries the most recent twenty. Anything materially short of that means posts are
    // being dropped, which is worse than failing outright because the record still looks fine.
    expect(posts.length).toBeGreaterThanOrEqual(18);
  });

  it('takes the time from Telegram rather than from our clock', () => {
    const posts = parsePreview('WCTCalls', fixture('wctcalls'));
    for (const p of posts) {
      expect(Number.isFinite(p.at)).toBe(true);
      // Plausible as a Telegram post: after the platform existed, not in the future.
      expect(p.at).toBeGreaterThan(Date.parse('2015-01-01'));
      expect(p.at).toBeLessThan(Date.now() + 60_000);
    }
    // This single field is why polling slowly costs nothing. Ordering proves it is being read
    // per post rather than one value being smeared across the page.
    const ids = posts.map((p) => p.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    const times = posts.map((p) => p.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps ids monotonic, which is what lets a pass know where it got to', () => {
    const posts = parsePreview('gogetacalls', fixture('gogetacalls'));
    expect(new Set(posts.map((p) => p.id)).size).toBe(posts.length);
  });

  it('keeps the line breaks a call is laid out with', () => {
    // Channels put the address on a line of its own under a label. Flattened to one line, the
    // label runs into the address and the parser never sees a valid one.
    const posts = parsePreview('WCTCalls', fixture('wctcalls'));
    expect(posts.some((p) => p.text.includes('\n'))).toBe(true);
  });

  it('leaves no markup or half-decoded entity in the text', () => {
    for (const name of ['wctcalls', 'gogetacalls']) {
      for (const p of parsePreview(name, fixture(name))) {
        expect(p.text).not.toMatch(/<[a-z/]/i);
        // `&#036;` is how Telegram escapes a dollar sign, and a hand-written list of named
        // entities misses it — which is how a call for $WIF reads back as gibberish.
        expect(p.text).not.toMatch(/&#\d+;|&#x[0-9a-f]+;|&(amp|lt|gt|quot|nbsp|lrm|rlm);/i);
      }
    }
  });

  it('does not let a post with no text of its own absorb the next one', () => {
    // A photo-only post has no message body. Without a bound at the next post's offset it
    // swallows the following message, attributing somebody's call to the wrong minute.
    const posts = parsePreview('gogetacalls', fixture('gogetacalls'));
    const addresses = posts.map((p) => p.text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) ?? []);
    expect(Math.max(...addresses.map((a) => a.length))).toBeLessThan(6);
  });

  it('returns nothing rather than throwing on a page it does not recognise', () => {
    expect(parsePreview('x', '<html><body>nope</body></html>')).toEqual([]);
    expect(parsePreview('x', '')).toEqual([]);
  });
});
