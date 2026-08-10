import type { ParsedCall } from '../types';
import type { Button } from '../telegram/transport';
import { chainLabel, dexScreenerUrl, hasTradeUrl, tradeUrl } from '../parse/chains';
import { escapeHtml, money } from './call';
import type { RenderOptions } from './call';

/**
 * A paid slot, and it has to look like one.
 *
 * The whole product rests on the channel's calls being reproducible, so an ad that reads like
 * a call is not a shortcut — it is the one thing that would make the track record worthless,
 * because a reader who finds out a card was bought has no way to tell which of the others were.
 * Undisclosed paid promotion is also the structure regulators treat as fraud rather than
 * advertising, which is the second reason and would be sufficient on its own.
 *
 * So: no `PUMPGOD ⚡` header, the word PAID at the top, and a line at the bottom saying we did
 * not pick it and are not tracking it. None of those three is decoration.
 */
export function renderPromo(call: ParsedCall, opts: RenderOptions): string {
  const { token, stats } = call;
  const title = call.name && call.ticker ? `${call.name} | ${call.ticker}` : (call.ticker ?? call.name ?? 'Promoted');

  const lines = [
    '📣 <b>PAID PROMOTION</b>',
    `<i>Someone paid to put this here. It is an advert, not a pumpgod call.</i>`,
    '',
    `<b>${escapeHtml(title)}</b>`,
    '',
    'CA:',
    `<code>${escapeHtml(token.address)}</code>`,
    '',
  ];

  const mc = money(stats.marketCapUsd);
  if (mc) lines.push(`📊 Market Cap: ${mc}`);
  lines.push(`🌐 ${chainLabel(token.chain)}`);
  const liq = money(stats.liquidityUsd);
  if (liq) lines.push(`💧 Liquidity: ${liq}`);

  const templates = { sol: opts.tradeUrlSol, evm: opts.tradeUrlEvm };
  const links = [`<a href="${dexScreenerUrl(token.chain, call.pairAddress, token.address)}">DexScreener</a>`];
  if (hasTradeUrl(token.chain, templates)) {
    links.push(`<a href="${tradeUrl(token.chain, token.address, templates)}">Buy</a>`);
  }
  lines.push('', links.join(' · '));

  // The last line, because it is the one a reader carries away — and because it is the exact
  // claim we would otherwise be making by putting the coin in front of them at all.
  lines.push(
    '',
    '<i>pumpgod did not choose this coin, has not screened it beyond checking it trades, ' +
      'and is not tracking it in the record. Nothing here is advice.</i>',
  );

  return lines.join('\n');
}

/** Buy leads here too — it is what the slot was bought for, and it is disclosed above it. */
export function promoButtons(call: ParsedCall, opts: RenderOptions): Button[][] {
  const { token } = call;
  const templates = { sol: opts.tradeUrlSol, evm: opts.tradeUrlEvm };

  const row: Button[] = [];
  if (hasTradeUrl(token.chain, templates)) {
    row.push({ text: '⚡ Buy', url: tradeUrl(token.chain, token.address, templates) });
  }
  row.push({ text: '📊 Chart', url: dexScreenerUrl(token.chain, call.pairAddress, token.address) });
  return [row];
}
