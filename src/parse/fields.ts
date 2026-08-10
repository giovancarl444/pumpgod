import type { Stats } from '../types';

const MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/** "$36.27K" → 36270, "1,234" → 1234, "2.1m" → 2100000. */
export function parseMoney(raw: string): number | undefined {
  const m = raw.match(/-?\$?\s*([\d,]+(?:\.\d+)?)\s*([kmbt])?/i);
  if (!m || !m[1]) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return undefined;
  const suffix = m[2]?.toLowerCase();
  return suffix ? n * (MULT[suffix] ?? 1) : n;
}

/** Grab the number that follows a label, stopping before the next emoji/label. */
function afterLabel(text: string, label: RegExp): string | undefined {
  const re = new RegExp(
    `${label.source}\\s*[:\\-–—>»]*\\s*(\\$?\\s*[\\d,]+(?:\\.\\d+)?\\s*[kmbtKMBT]?)`,
    'i',
  );
  return text.match(re)?.[1];
}

export function extractStats(text: string): Stats {
  const stats: Stats = {};

  const mc =
    afterLabel(text, /market\s*cap/) ??
    afterLabel(text, /\bmcap\b/) ??
    afterLabel(text, /\bm\.?c\b/) ??
    afterLabel(text, /\bfdv\b/);
  if (mc) stats.marketCapUsd = parseMoney(mc);

  const liq = afterLabel(text, /liquidity/) ?? afterLabel(text, /\bliq\b/) ?? afterLabel(text, /\blp\b/);
  if (liq) stats.liquidityUsd = parseMoney(liq);

  const vol =
    afterLabel(text, /(?:24h?\s*)?volume/) ?? afterLabel(text, /\bvol\b/) ?? afterLabel(text, /\bv\b/);
  if (vol) stats.volumeUsd = parseMoney(vol);

  const holders = afterLabel(text, /holders/) ?? afterLabel(text, /\bhodlers\b/);
  if (holders) stats.holders = parseMoney(holders);

  // `\b` matters most on the short labels. "age" and "price" are spellable in base58, so
  // without it they match *inside* a mint address and read the characters after them as a
  // value — the longer labels above cannot, because base58 has no `l`.
  const price = text.match(/\bprice\b\s*[:\-–—>»]*\s*(\$?\s*[\d.,]+(?:e-?\d+)?)/i)?.[1];
  if (price) stats.priceUsd = parseMoney(price);

  const age = text.match(/\b(?:token\s*)?age\b\s*[:\-–—>»]*\s*([\d]+\s*[a-z]+(?:\s*[\d]+\s*[a-z]+)?)/i)?.[1];
  if (age) stats.ageText = age.trim();

  return stats;
}

const TICKER_STOPWORDS = new Set([
  'CA', 'MC', 'MCAP', 'FDV', 'LP', 'ATH', 'DEX', 'DYOR', 'NFA', 'NEW', 'BUY', 'SELL',
  'USD', 'SOL', 'ETH', 'BNB', 'AI', 'THE', 'AND', 'FOR', 'ALL', 'GEM', 'GEMS', 'CALL',
]);

function cleanTicker(raw: string): string | undefined {
  const t = raw.replace(/^\$/, '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(t)) return undefined;
  if (/^\d+$/.test(t)) return undefined;
  return t;
}

/**
 * Names and tickers vary wildly between groups, so try the strong explicit forms first
 * and only then fall back to layout conventions like "Name | TICKER".
 */
export function extractIdentity(text: string): { name?: string; ticker?: string } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let name: string | undefined;
  let ticker: string | undefined;

  const labelledTicker = text.match(/\b(?:ticker|symbol)\s*[:\-–—>»]*\s*\$?([A-Za-z0-9]{2,12})\b/i)?.[1];
  if (labelledTicker) ticker = cleanTicker(labelledTicker);

  const labelledName = text.match(/\bname\s*[:\-–—>»]*\s*(.{2,48}?)(?:\n|$)/i)?.[1];
  if (labelledName) name = labelledName.trim();

  for (const line of lines.slice(0, 4)) {
    if (name && ticker) break;

    // "Troll in Hood | TROLL"
    const piped = line.match(/^(.{2,64}?)\s*[|｜]\s*\$?([A-Za-z0-9]{2,12})\s*$/);
    if (piped?.[1] && piped[2]) {
      const t = cleanTicker(piped[2]);
      if (t) {
        ticker ??= t;
        name ??= piped[1].trim();
        continue;
      }
    }

    // "Troll in Hood ($TROLL)" or "Troll in Hood (TROLL)"
    const paren = line.match(/^(.{2,64}?)\s*\(\s*\$?([A-Za-z0-9]{2,12})\s*\)/);
    if (paren?.[1] && paren[2]) {
      const t = cleanTicker(paren[2]);
      if (t && !TICKER_STOPWORDS.has(t)) {
        ticker ??= t;
        name ??= paren[1].trim();
        continue;
      }
    }
  }

  if (!ticker) {
    for (const m of text.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,11})\b/g)) {
      const t = m[1] ? cleanTicker(m[1]) : undefined;
      if (t && !TICKER_STOPWORDS.has(t)) {
        ticker = t;
        break;
      }
    }
  }

  if (name) {
    name = name
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[*_`~]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!name || name.length < 2) name = undefined;
  }

  return { name, ticker };
}
