import type { ParsedCall } from '../types';
import { extractAddresses } from './addresses';
import { extractIdentity, extractStats } from './fields';
import { chainFromText } from './chains';

/** Telegram entity, narrowed to the fields the parser cares about. */
export interface ParseEntity {
  offset: number;
  length: number;
  url?: string;
  className?: string;
}

export interface ParseInput {
  text: string;
  entities?: ParseEntity[];
}

/**
 * One cheap pass that rejects ordinary chatter before we do any real work. Roughly 95%
 * of traffic in a busy group is not a call, and this keeps those under ~2µs.
 */
const HAS_ADDRESS = /0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/;

export function looksLikeCall(text: string): boolean {
  return HAS_ADDRESS.test(text);
}

/**
 * Telegram sends hyperlink targets in entities, not in the message body, so a link-heavy
 * call arrives as bare text. We fold the entity URLs back in before scanning, and drop
 * the group's own branding link so it does not get mistaken for the token name.
 */
function prepare(input: ParseInput): { scan: string; display: string } {
  const { text, entities } = input;
  if (!entities?.length) return { scan: text, display: text };

  const urls: string[] = [];
  const cuts: Array<[number, number]> = [];

  for (const e of entities) {
    if (!e.url) continue;
    urls.push(e.url);
    if (/(?:^|\/\/)(?:t\.me|telegram\.me)\//i.test(e.url)) cuts.push([e.offset, e.length]);
  }

  let display = text;
  if (cuts.length) {
    cuts.sort((a, b) => b[0] - a[0]);
    for (const [offset, length] of cuts) {
      display = display.slice(0, offset) + display.slice(offset + length);
    }
    display = display.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+/gm, '');
  }

  const scan = urls.length ? `${text}\n${urls.join('\n')}` : text;
  return { scan, display };
}

export function parseCall(input: string | ParseInput): ParsedCall | null {
  const normalised: ParseInput = typeof input === 'string' ? { text: input } : input;
  if (!normalised.text) return null;

  // Prefilter after folding in entity URLs — a message whose body is just "Chart" can
  // still carry the contract address in a hyperlink target.
  const { scan, display } = prepare(normalised);
  if (!looksLikeCall(scan)) return null;

  const { tokens, pairAddress } = extractAddresses(scan);
  const best = tokens[0];
  if (!best) return null;

  const identity = extractIdentity(display);
  const stats = extractStats(display);

  const token = { ...best };
  if (token.chain === 'unknown') {
    token.chain = chainFromText(display) ?? (token.kind === 'evm' ? 'ethereum' : 'unknown');
  }

  return {
    token,
    pairAddress,
    name: identity.name,
    ticker: identity.ticker,
    stats,
    candidates: tokens,
  };
}
