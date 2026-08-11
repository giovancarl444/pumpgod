import type { Signal } from '../types';
import type { Button } from '../telegram/transport';
import { chainLabel, dexScreenerUrl, explorerUrl, hasTradeUrl, tradeUrl } from '../parse/chains';
import { headlineFlag } from '../pipeline/risk';

export interface RenderOptions {
  footer: string;
  showSource: boolean;
  tradeUrlSol: string;
  tradeUrlEvm: string;
  referralUrl?: string;
  referralLabel: string;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function money(n: number | undefined): string | undefined {
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `$${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `$${trim(n / 1e3)}K`;
  return `$${trim(n)}`;
}

export function duration(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function trim(n: number): string {
  const fixed = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2);
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

function heading(signal: Signal): string {
  const { name, ticker } = signal.call;
  if (name && ticker) return `<b>${escapeHtml(name)}</b> ($${escapeHtml(ticker)})`;
  if (ticker) return `<b>$${escapeHtml(ticker)}</b>`;
  if (name) return `<b>${escapeHtml(name)}</b>`;
  return '<b>New call</b>';
}

function statLine(signal: Signal): string | undefined {
  const { stats } = signal.call;
  const parts = [
    money(stats.marketCapUsd) && `MC ${money(stats.marketCapUsd)}`,
    money(stats.liquidityUsd) && `LIQ ${money(stats.liquidityUsd)}`,
    money(stats.volumeUsd) && `VOL ${money(stats.volumeUsd)}`,
  ].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : undefined;
}

function contextLine(signal: Signal): string {
  const parts = [chainLabel(signal.call.token.chain)];
  if (signal.call.stats.ageText) parts.push(`${signal.call.stats.ageText} old`);
  if (signal.confirmations.length > 1) parts.push(`${signal.confirmations.length}× confirmed`);
  return parts.join(' · ');
}

/**
 * Public calls get one summary line, because a wall of caveats trains people to skip them.
 * The war room gets every flag spelled out — that reader is deciding, not browsing.
 */
function riskLine(signal: Signal, verbose: boolean): string | undefined {
  const { level, flags } = signal.risk;
  if (level === 'clear' || !flags.length) return undefined;

  const icon = level === 'danger' ? '🚨' : '⚠️';
  if (verbose) return flags.map((f) => `${f.level === 'danger' ? '🚨' : '⚠️'} ${escapeHtml(f.detail)}`).join('\n');
  // The worst flag rather than the first. They are not the same list position, and the one
  // time it matters most is the one the reader can do least about.
  return `${icon} <b>${escapeHtml(headlineFlag(flags)!.detail)}</b>`;
}

/** Below this the pool cannot be exited, and the screen flags it. Kept in step with `risk.ts`. */
const OK_LIQUIDITY_USD = 3_000;

/**
 * The one line a clean screen earns.
 *
 * Built from what was actually read, never from the absence of flags — those are not the same
 * statement, and the gap between them is the whole risk. `chainFlags` returns nothing at all
 * when the chain was never asked, which is right for the relay path where a warning on every
 * call would bury the real ones, but it means a verdict of `clear` quietly includes "we did
 * not look". A card claiming the mint is revoked when nobody read the mint is worse than a
 * card that says nothing: it is the exact assurance people are being asked to trust us for.
 *
 * So each half is earned separately. The authorities are claimed only against a mint we hold
 * and both keys confirmed dead; the depth only against a real reading above the floor. If
 * neither was checked the line does not appear, and the card is silent rather than reassuring.
 */
function clearedLine(signal: Signal): string | undefined {
  if (signal.risk.level !== 'clear' || signal.risk.flags.length) return undefined;

  const parts: string[] = [];

  const mint = signal.call.onchain?.mint;
  if (mint && !mint.freezeAuthority && !mint.mintAuthority) parts.push('mint &amp; freeze revoked');

  const liquidity = signal.call.stats.liquidityUsd;
  if (liquidity !== undefined && liquidity >= OK_LIQUIDITY_USD) parts.push('liquidity ok');

  return parts.length ? `✅ <b>${parts.join(' · ')}</b>` : undefined;
}

function signalTitle(signal: Signal): string {
  const { name, ticker } = signal.call;
  const label = name && ticker ? `${name} | ${ticker}` : ticker || name || 'New call';
  return `<b>${escapeHtml(label)}</b>`;
}

/**
 * One fact per line, each behind its own icon. This is the shape the call groups people
 * already follow use, and it survives because a reader scanning a phone finds the number
 * they care about by its icon — a run-on stat line makes them read all of it or none.
 */
function statBlock(signal: Signal): string[] {
  const { stats, token } = signal.call;
  const lines: string[] = [];

  const mc = money(stats.marketCapUsd);
  if (mc) lines.push(`📊 Market Cap: ${mc}`);
  lines.push(`🌐 ${chainLabel(token.chain)}`);

  const liq = money(stats.liquidityUsd);
  if (liq) lines.push(`💧 Liquidity: ${liq}`);
  const vol = money(stats.volumeUsd);
  if (vol) lines.push(`📈 Volume: ${vol}`);
  if (stats.ageText) lines.push(`⏰ Token Age: ${escapeHtml(stats.ageText)}`);

  // The one number no other group can show, so it earns its line when it exists.
  if (signal.confirmations.length > 1) lines.push(`✅ ${signal.confirmations.length}× confirmed`);

  return lines;
}

/**
 * Inline anchors rather than an inline keyboard: reply markup is bot-only, and pumpgod
 * posts from a user account so it can also read the groups it tracks.
 */
function linkLine(signal: Signal, opts: RenderOptions): string {
  const { token, pairAddress } = signal.call;
  const links = [
    `<a href="${dexScreenerUrl(token.chain, pairAddress, token.address)}">Chart</a>`,
    `<a href="${tradeUrl(token.chain, token.address, { sol: opts.tradeUrlSol, evm: opts.tradeUrlEvm })}">Buy</a>`,
    `<a href="${explorerUrl(token.chain, token.address)}">Scan</a>`,
  ];
  return links.join(' · ');
}

/**
 * A signal, not an analysis. Anything that needs a second read — holder counts, parse
 * confidence, timings — belongs in the war room, where somebody is deciding rather than
 * scrolling. `CA:` gets its own line so the address below it is a clean tap-to-copy target.
 */
export function renderPublicCall(signal: Signal, opts: RenderOptions): string {
  const { token, pairAddress } = signal.call;
  const lines = [
    '<b>PUMPGOD</b> ⚡',
    signalTitle(signal),
    '',
    'CA:',
    `<code>${escapeHtml(token.address)}</code>`,
    '',
    ...statBlock(signal),
  ];

  // Above the links, so a danger flag cannot be scrolled past on the way to Buy. The cleared
  // line sits in the same place for the same reason: it is the answer to the question the
  // reader is actually asking before they tap.
  const risk = riskLine(signal, false) ?? clearedLine(signal);
  if (risk) lines.push('', risk);

  // The links are an action rather than another fact, so they are always set off from the
  // stats. Carrying the gap on the risk line instead left the ordinary card — the one with
  // nothing to flag, which is most of them — reading Buy as one more stat row.
  lines.push('');

  const templates = { sol: opts.tradeUrlSol, evm: opts.tradeUrlEvm };
  const links = [`<a href="${dexScreenerUrl(token.chain, pairAddress, token.address)}">DexScreener</a>`];
  if (hasTradeUrl(token.chain, templates)) {
    links.push(`<a href="${tradeUrl(token.chain, token.address, templates)}">Buy</a>`);
  }
  lines.push(links.join(' · '));

  if (opts.showSource) lines.push('', `<i>via ${escapeHtml(signal.source.label)}</i>`);

  // These terminals attribute referrals at signup, not per trade, so the money is made by
  // the link that gets read every call — not by decorating each Buy button.
  if (opts.referralUrl) {
    lines.push('', `⚡ <a href="${opts.referralUrl}">${escapeHtml(opts.referralLabel)}</a>`);
  }
  if (opts.footer) lines.push('', `<i>${escapeHtml(opts.footer)}</i>`);

  return lines.join('\n');
}

/**
 * The links again, as buttons — a thumb-sized target instead of a word in a row of words.
 *
 * **Strictly additive.** The anchor row inside the card stays exactly where it is, because the
 * MTProto transport drops reply markup and cannot do otherwise: the same card posted from the
 * reader account would lose its Buy link with no error raised anywhere. A button is a nicer way
 * to reach something that is already reachable, never the only way.
 *
 * Buy leads, because it is the only line on the card that earns anything.
 */
export function callButtons(signal: Signal, opts: RenderOptions): Button[][] {
  const { token, pairAddress } = signal.call;
  const templates = { sol: opts.tradeUrlSol, evm: opts.tradeUrlEvm };

  const row: Button[] = [];
  if (hasTradeUrl(token.chain, templates)) {
    row.push({ text: '⚡ Buy now', url: tradeUrl(token.chain, token.address, templates) });
  }
  row.push({ text: '📊 Chart', url: dexScreenerUrl(token.chain, pairAddress, token.address) });

  const rows = [row];
  if (opts.referralUrl) rows.push([{ text: opts.referralLabel, url: opts.referralUrl }]);
  return rows;
}

/** The first line answers "why is this in front of me", which is not always the source's mode. */
function warRoomHeading(signal: Signal): string {
  const who = `<b>${escapeHtml(signal.source.label)}</b>`;
  if (signal.stale) return `⏳ ${who} · posted ${signal.ageSec}s ago, NOT fresh`;
  if (signal.risk.level === 'danger' && signal.source.mode === 'auto') return `🚨 ${who} · auto source, HELD BACK`;
  return `🔎 ${who} · ${signal.source.mode}`;
}

/**
 * The war-room card optimises for a one-second decision: what it is, how far we trust
 * the parse, and how fast we saw it. Approval happens by reacting to this message.
 */
export function renderWarRoomCall(signal: Signal, opts: RenderOptions): string {
  const { token, stats } = signal.call;
  const detectMs = signal.timings.parsedAt ? signal.timings.parsedAt - signal.timings.recvAt : undefined;

  const lines = [
    warRoomHeading(signal),
    '',
    heading(signal),
    `<code>${escapeHtml(token.address)}</code>`,
  ];

  const s = statLine(signal);
  if (s) lines.push('', s);
  lines.push(contextLine(signal));

  const risk = riskLine(signal, true);
  if (risk) lines.push('', risk);

  lines.push('', linkLine(signal, opts));

  const detail = [`${token.origin} ${Math.round(token.confidence * 100)}%`];
  if (detectMs !== undefined) detail.push(`parsed ${detectMs.toFixed(2)}ms`);
  if (stats.holders) detail.push(`${stats.holders} holders`);

  lines.push('', `<i>${detail.join(' · ')}</i>`, '🚀 fire · 👎 skip');
  return lines.join('\n');
}
