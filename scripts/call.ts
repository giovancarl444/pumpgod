import { loadPresentation } from '../src/config';
import { resolveManualCall, MANUAL_SOURCE } from '../src/pipeline/manual';
import { assess } from '../src/pipeline/risk';
import { renderPublicCall } from '../src/format/call';
import type { Signal } from '../src/types';

/**
 * Shows exactly what pumpgod would post for an address, without posting it and without
 * needing a Telegram account. Publishing deliberately lives in the running bot instead —
 * one process owns the dedupe window and the outcome tracker, and a second writer would
 * corrupt both. To actually call a coin, type `call <address>` in the war room.
 */
async function main() {
  const input = process.argv.slice(2).join(' ').trim();
  if (!input) {
    console.error('\n  usage: npm run call -- <address or link>\n');
    process.exit(1);
  }

  const config = loadPresentation();
  const started = Date.now();
  const outcome = await resolveManualCall(input, Math.max(config.enrichTimeoutMs, 5000));

  if (!outcome.ok) {
    console.error(`\n  ✗ ${outcome.reason}\n`);
    process.exit(1);
  }

  const risk = assess(outcome.call);
  const signal: Signal = {
    id: 'preview',
    source: MANUAL_SOURCE,
    chatId: 'manual',
    messageId: 0,
    rawText: input,
    call: outcome.call,
    confirmations: [MANUAL_SOURCE.id],
    ageSec: 0,
    stale: false,
    risk,
    enriched: true,
    timings: { messageUnix: Math.floor(Date.now() / 1000), recvAt: 0, wallClockMs: Date.now() },
  };

  console.log(`\n  resolved in ${Date.now() - started}ms\n`);
  console.log(frame(renderPublicCall(signal, config)));

  if (risk.level === 'danger') {
    console.log('\n  🚨 the screen would HOLD THIS BACK — it goes to the war room, not the channel:');
    for (const f of risk.flags) console.log(`     ${f.level === 'danger' ? '🚨' : '⚠️'} ${f.detail}`);
    console.log('\n  publishing it anyway is a decision, not a default.\n');
    return;
  }

  if (risk.flags.length) {
    console.log('\n  screen: caution');
    for (const f of risk.flags) console.log(`     ⚠️  ${f.detail}`);
  } else {
    console.log('\n  screen: clear');
  }

  if (!config.referralUrl) {
    console.log('  note: REFERRAL_URL is empty, so this call earns nothing. Set it in .env.');
  }
  console.log(`\n  to publish it: type "call ${outcome.call.token.address}" in the war room\n`);
}

/** Renders the Telegram HTML as a terminal card, keeping link targets visible — those are
 *  the part most likely to be wrong and least likely to be noticed. */
function frame(html: string): string {
  const text = html
    .replace(/<a href="([^"]+)">([^<]*)<\/a>/g, (_, url: string, label: string) => `${label} → ${url}`)
    .replace(/<\/?(?:b|i|code|u|s)>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

  const width = 74;
  const top = `  ┌─ public channel ${'─'.repeat(Math.max(0, width - 18))}`;
  const body = text.split('\n').map((l) => `  │ ${l}`).join('\n');
  return `${top}\n${body}\n  └${'─'.repeat(width)}`;
}

main().catch((err) => {
  console.error(`\n  ✗ ${(err as Error).message}\n`);
  process.exit(1);
});
