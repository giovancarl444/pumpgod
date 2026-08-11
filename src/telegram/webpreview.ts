import { log } from '../log';

/**
 * Reading a public channel through Telegram's own web preview — `t.me/s/<handle>`.
 *
 * ## Why this exists when there is already an MTProto reader
 *
 * Watching a rival group was the one thing on the whole plan that needed a logged-in account,
 * because a bot cannot see a chat it was not added to. That account is bannable, and it has to
 * join seventy-odd groups to be useful, so the measurement everything else depends on was
 * gated behind a real risk taken up front.
 *
 * It turns out only half of that is true, and the half that is false is the half we needed
 * first. **Measuring who is good needs no speed. Only copying them does.** A scorecard asks
 * what was called and when; it does not care whether we heard about it two seconds or two
 * minutes later — because the timestamp comes off Telegram's own `datetime` attribute, not off
 * our clock. A slow poll therefore costs nothing at all to the numbers.
 *
 * So the two jobs split, and the risky one moves to the end:
 *
 * - **Measure** every candidate group from here. No account, no login, no joining, no ban.
 * - **Relay** the three that earn it — later, over MTProto, where the round trip is the
 *   difference between first and second.
 *
 * That is strictly better than the original order. The account risk is taken on the groups the
 * record already justified, weeks from now, instead of on seventy-five of them today.
 *
 * ## What this can and cannot see
 *
 * It is the page a browser gets. Nothing is authenticated and nothing is joined, which also
 * bounds it honestly:
 *
 * - Only channels whose owner left the public preview on. Most call channels have, because it
 *   is how they are found.
 * - The most recent ~20 posts per request. `before` pages backwards through the history.
 * - A post edited or deleted after the fact reads as it stands now, not as it was. For a
 *   scorecard that is a real hole and worth remembering: a group can quietly delete its losers.
 *   The defence is polling often enough to have seen the post before it was tidied away, which
 *   is the one argument for a short interval here.
 */

/** One post, as Telegram itself renders it to the public. */
export interface PreviewPost {
  handle: string;
  /** The per-channel message id, from `data-post="handle/123"`. Monotonic, so it dedupes. */
  id: number;
  /**
   * When the channel posted it, in ms.
   *
   * Telegram's own `<time datetime>`, never our fetch time. This single field is why polling
   * slowly is free: a call recorded an hour late still carries the minute it was actually made,
   * so entry prices and time-to-2x stay honest.
   */
  at: number;
  /** Plain text, with the markup stripped and entities decoded. */
  text: string;
}

export interface PreviewOptions {
  timeoutMs?: number;
  /** Page backwards: return posts older than this message id. */
  before?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

const BASE = 'https://t.me/s';
const TIMEOUT_MS = 10_000;

/**
 * A browser-ish User-Agent, because the preview is a page meant for browsers.
 *
 * Not an attempt to be sneaky — the same URL in Safari returns the same bytes. Telegram serves
 * a stripped page to clients it does not recognise, and a stripped page has no `datetime`
 * attributes, which would silently cost us the one field the whole approach rests on.
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

export async function fetchPreview(handle: string, options: PreviewOptions = {}): Promise<PreviewPost[]> {
  const name = handle.replace(/^@/, '');
  const url = options.before ? `${BASE}/${name}?before=${options.before}` : `${BASE}/${name}`;
  const doFetch = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': UA, accept: 'text/html' },
    });
    // A private, renamed or preview-disabled channel is a 404 rather than an error, and it is
    // a permanent state — the caller wants to stop asking, not to retry.
    if (!res.ok) {
      log.debug(`t.me/s/${name} returned ${res.status}`);
      return [];
    }
    return parsePreview(name, await res.text());
  } catch (err) {
    log.debug(`could not read t.me/s/${name}: ${(err as Error).message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the posts out of the page.
 *
 * Exported so it can be tested against saved HTML. Telegram will change this markup eventually
 * and a fixture is the only thing that will tell us it happened — a scraper that silently
 * starts returning zero posts looks exactly like a quiet channel.
 */
export function parsePreview(handle: string, html: string): PreviewPost[] {
  const posts: PreviewPost[] = [];
  // Each post begins with its own id, which is also the only reliable place the id appears.
  const wrapper = /data-post="([^"/]+)\/(\d+)"/g;

  const starts: Array<{ id: number; at: number }> = [];
  const offsets: number[] = [];
  for (let m = wrapper.exec(html); m; m = wrapper.exec(html)) {
    starts.push({ id: Number(m[2]), at: 0 });
    offsets.push(m.index);
  }

  for (let i = 0; i < starts.length; i++) {
    const from = offsets[i]!;
    // Bounded by the next post so a message with no text of its own cannot absorb the next
    // one's — which would attribute somebody's call to the wrong minute, and to a photo.
    const to = i + 1 < offsets.length ? offsets[i + 1]! : html.length;
    const chunk = html.slice(from, to);

    const time = /datetime="([^"]+)"/.exec(chunk);
    const at = time ? Date.parse(time[1]!) : NaN;
    if (!Number.isFinite(at)) continue;

    const text = messageText(chunk);
    if (!text) continue;

    posts.push({ handle, id: starts[i]!.id, at, text });
  }

  return posts;
}

/**
 * The message body, by depth rather than by the first closing tag.
 *
 * A non-greedy `(.*?)</div>` works on most posts and truncates the ones that matter — a call
 * with a quoted block or a link preview inside it nests, and the address is usually below the
 * fold. Counting is a dozen lines and cannot be wrong about it.
 */
function messageText(chunk: string): string | undefined {
  const open = /<div[^>]*js-message_text[^>]*>/.exec(chunk);
  if (!open) return undefined;

  let i = open.index + open[0].length;
  let depth = 1;
  const start = i;

  while (i < chunk.length && depth > 0) {
    const nextOpen = chunk.indexOf('<div', i);
    const nextClose = chunk.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return plain(chunk.slice(start, nextClose));
      i = nextClose + 6;
    }
  }
  return undefined;
}

/**
 * Markup out, entities back in, line breaks kept.
 *
 * The breaks matter: call posts put the contract address on a line of its own under a label,
 * and flattening the whole post to one line joins the label to the address before the parser
 * ever sees it.
 */
function plain(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      // Numeric entities before named ones, and both before `&amp;`. Telegram escapes `$` as
      // `&#036;` — a zero-padded decimal that a hand-written list of named entities misses
      // entirely, which is how a call for `&#036;WIF` reads back as gibberish.
      .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => cp(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => cp(Number(dec)))
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // Direction marks. Channels sprinkle these around addresses to force layout, and they
      // survive every other step invisibly — leaving a "clean" string that will not compare
      // equal to the same address typed anywhere else.
      .replace(/&(lrm|rlm|zwj|zwnj);/g, '')
      .replace(/[​-‏‪-‮⁦-⁩﻿]/g, '')
      // Last, or an already-escaped entity in the post text is decoded twice.
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/** Guards against a malformed entity turning into an exception mid-page. */
function cp(code: number): string {
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}
