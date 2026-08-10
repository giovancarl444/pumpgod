import type { Signal } from '../types';
import { chainLabel, dexScreenerUrl, explorerUrl, tradeUrl } from '../parse/chains';

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

function trim(n: number): string {
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
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
  return `${icon} <b>${escapeHtml(flags[0]!.detail)}</b>`;
}

/**
 * Inline anchors rather than an inline keyboard: reply markup is bot-only, and pumpgod
 * posts from a user account so it can also read the groups it tracks.
 */
function linkLine(signal: Signal): string {
  const { token, pairAddress } = signal.call;
  const links = [
    `<a href="${dexScreenerUrl(token.chain, pairAddress, token.address)}">Chart</a>`,
    `<a href="${tradeUrl(token.chain, token.address)}">Buy</a>`,
    `<a href="${explorerUrl(token.chain, token.address)}">Scan</a>`,
  ];
  return links.join(' · ');
}

export function renderPublicCall(signal: Signal, opts: { footer: string; showSource: boolean }): string {
  const lines = [
    '⚡ <b>PUMPGOD CALL</b>',
    '',
    heading(signal),
    `<code>${escapeHtml(signal.call.token.address)}</code>`,
  ];

  const stats = statLine(signal);
  if (stats) lines.push('', stats);
  lines.push(contextLine(signal));

  const risk = riskLine(signal, false);
  if (risk) lines.push('', risk);

  lines.push('', linkLine(signal));

  if (opts.showSource) lines.push(`<i>via ${escapeHtml(signal.source.label)}</i>`);
  if (opts.footer) lines.push('', `<i>${escapeHtml(opts.footer)}</i>`);

  return lines.join('\n');
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
export function renderWarRoomCall(signal: Signal): string {
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

  lines.push('', linkLine(signal));

  const detail = [`${token.origin} ${Math.round(token.confidence * 100)}%`];
  if (detectMs !== undefined) detail.push(`parsed ${detectMs.toFixed(2)}ms`);
  if (stats.holders) detail.push(`${stats.holders} holders`);

  lines.push('', `<i>${detail.join(' · ')}</i>`, '🚀 fire · 👎 skip');
  return lines.join('\n');
}
