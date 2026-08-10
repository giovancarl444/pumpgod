import { Api } from 'telegram';

/**
 * A minimal HTML subset — b, i, u, s, code, pre, a — compiled straight into Telegram
 * message entities. GramJS has its own parser, but it is a private client method that
 * builds a full Message object we would immediately discard.
 */
const TAG = /<(\/?)(b|i|u|s|code|pre|a)(?:\s+href="([^"]*)")?>/gi;

interface Open {
  tag: string;
  offset: number;
  href?: string;
}

export interface ParsedHtml {
  text: string;
  entities: Api.TypeMessageEntity[];
}

export function parseHtml(html: string): ParsedHtml {
  const entities: Api.TypeMessageEntity[] = [];
  const stack: Open[] = [];
  const out: string[] = [];
  let offset = 0;
  let last = 0;
  TAG.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = TAG.exec(html)) !== null) {
    const chunk = unescapeHtml(html.slice(last, m.index));
    out.push(chunk);
    // Telegram entity offsets count UTF-16 code units, which is exactly what
    // String.length gives us — so emoji outside the BMP correctly count as 2.
    offset += chunk.length;
    last = m.index + m[0].length;

    const closing = m[1] === '/';
    const tag = m[2]!.toLowerCase();

    if (closing) {
      const idx = findLast(stack, tag);
      if (idx === -1) continue;
      const open = stack.splice(idx, 1)[0]!;
      const length = offset - open.offset;
      if (length > 0) entities.push(makeEntity(open, length));
    } else {
      stack.push({ tag, offset, href: m[3] });
    }
  }

  out.push(unescapeHtml(html.slice(last)));

  // Telegram rejects overlapping or out-of-order entities on some clients.
  entities.sort((a, b) => a.offset - b.offset);

  return { text: out.join(''), entities };
}

function makeEntity(open: Open, length: number): Api.TypeMessageEntity {
  const args = { offset: open.offset, length };
  switch (open.tag) {
    case 'b':
      return new Api.MessageEntityBold(args);
    case 'i':
      return new Api.MessageEntityItalic(args);
    case 'u':
      return new Api.MessageEntityUnderline(args);
    case 's':
      return new Api.MessageEntityStrike(args);
    case 'code':
      return new Api.MessageEntityCode(args);
    case 'pre':
      return new Api.MessageEntityPre({ ...args, language: '' });
    default:
      return new Api.MessageEntityTextUrl({ ...args, url: open.href ?? '' });
  }
}

function findLast(stack: Open[], tag: string): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.tag === tag) return i;
  return -1;
}

function unescapeHtml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
