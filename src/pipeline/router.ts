import { Api, TelegramClient } from 'telegram';
import type { AppConfig } from '../config';
import type { Signal, Source } from '../types';
import { parseCall } from '../parse';
import { renderPublicCall, renderWarRoomCall } from '../format/call';
import { editFast, sendFast } from '../telegram/send';
import type { IncomingMessage, IncomingReaction } from '../telegram/ingest';
import { Dedupe } from './dedupe';
import { enrich } from './enrich';
import { assess } from './risk';
import { record } from '../metrics/latency';
import { journal } from '../store/journal';
import { Tracker } from '../track/tracker';
import { log } from '../log';

const FIRE = new Set(['🚀', '🔥', '⚡', '👍', '✅', '💎']);
const SKIP = new Set(['👎', '❌', '🤡', '💩']);

/** War-room cards expire so a stale reaction cannot fire a call from an hour ago. */
const STAGE_TTL_MS = 30 * 60_000;

interface Staged {
  signal: Signal;
  stagedAt: number;
  fired: boolean;
}

export class Router {
  private readonly dedupe: Dedupe;
  private readonly staged = new Map<number, Staged>();
  private counter = 0;

  constructor(
    private readonly client: TelegramClient,
    private readonly config: AppConfig,
    private readonly channelPeer: Api.TypeInputPeer | undefined,
    private readonly warRoomPeer: Api.TypeInputPeer | undefined,
    private readonly tracker?: Tracker,
  ) {
    this.dedupe = new Dedupe(config.dedupeTtlMs);
  }

  /**
   * Runs inside the update handler, so everything here is synchronous up to the point a
   * send is dispatched. Journalling, enrichment and metrics all happen behind that.
   */
  handleMessage(incoming: IncomingMessage): void {
    const call = parseCall({ text: incoming.text, entities: incoming.entities });
    const parsedAt = performance.now();
    record('parse', parsedAt - incoming.recvAt);

    if (!call) return;
    if (!this.passesFilters(incoming.source, call)) return;

    const { first, entry } = this.dedupe.check(call.token.chain, call.token.address, incoming.source.id);

    // Telegram stamps messages in whole seconds, so this is coarse — but it only needs to
    // separate "just now" from "recovered after an outage".
    const ageSec = Math.max(0, Math.round(Date.now() / 1000 - incoming.messageUnix));

    const signal: Signal = {
      id: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`,
      source: incoming.source,
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      rawText: incoming.text,
      call,
      confirmations: entry.sources,
      ageSec,
      stale: ageSec > this.config.maxCallAgeSec,
      // Pure arithmetic on numbers the source already gave us — sub-microsecond, so it can
      // gate the publish. Re-read against real market data in `upgrade`.
      risk: assess(call),
      timings: {
        messageUnix: incoming.messageUnix,
        recvAt: incoming.recvAt,
        parsedAt,
        wallClockMs: Date.now(),
      },
    };

    if (!first) {
      log.debug(`dup ${call.token.address} (${entry.sources.join(', ')})`);
      journal.write('duplicate', { id: signal.id, source: incoming.source.id, address: call.token.address });
      return;
    }

    if (incoming.source.mode === 'shadow') {
      log.info(`👻 shadow ${label(signal)} from ${incoming.source.label}`);
      journal.write('shadow', this.record(signal));
      // Tracked anyway — knowing what a source *would* have made us is the whole
      // reason shadow mode exists.
      this.tracker?.track(signal, 'shadow');
      return;
    }

    // Two things override a source's mode, both for the same reason: publishing them as
    // ordinary calls is how a call group loses trust. A stale call is one we recovered after
    // an outage or were too slow to see. A dangerous one is untradable — no exit liquidity,
    // an unbacked price, or a move that already happened. Neither is auto-published.
    const divert = signal.stale || signal.risk.level === 'danger';
    if (incoming.source.mode === 'auto' && !divert) {
      void this.fire(signal);
    } else {
      if (signal.stale) log.warn(`⏳ ${label(signal)} is ${signal.ageSec}s old — routing to review`);
      if (signal.risk.level === 'danger') {
        log.warn(`⚠️  ${label(signal)} — ${signal.risk.flags.map((f) => f.detail).join('; ')}`);
      }
      void this.stage(signal);
    }
  }

  private passesFilters(source: Source, call: NonNullable<ReturnType<typeof parseCall>>): boolean {
    if (source.chains?.length && !source.chains.includes(call.token.chain)) return false;

    const mc = call.stats.marketCapUsd;
    if (mc !== undefined) {
      if (source.minMarketCapUsd !== undefined && mc < source.minMarketCapUsd) return false;
      if (source.maxMarketCapUsd !== undefined && mc > source.maxMarketCapUsd) return false;
    }
    return true;
  }

  /** Publish to the public channel, then upgrade the message once enrichment lands. */
  private async fire(signal: Signal): Promise<void> {
    if (!this.config.live || !this.channelPeer) {
      log.info(`🔇 DRY RUN would call ${label(signal)} (LIVE=false)`);
      journal.write('dry-run', this.record(signal));
      // Still tracked, so a dry run produces a real scorecard rather than nothing.
      this.tracker?.track(signal, 'dry-run');
      return;
    }

    try {
      const html = renderPublicCall(signal, {
        footer: this.config.footer,
        showSource: this.config.showSource,
      });
      const sent = await sendFast(this.client, this.channelPeer, html, { stage: 'send.public' });

      signal.timings.dispatchAt = sent.dispatchAt;
      signal.timings.ackAt = sent.ackAt;
      record('detect-to-ack', sent.ackAt - signal.timings.recvAt);
      record('detect-to-dispatch', sent.dispatchAt - signal.timings.recvAt);

      if (sent.messageId) this.dedupe.markPublished(signal.call.token.chain, signal.call.token.address, sent.messageId);

      log.info(
        `🚀 CALLED ${label(signal)} · ${(sent.ackAt - signal.timings.recvAt).toFixed(1)}ms end-to-end`,
      );
      journal.write('called', this.record(signal));
      this.tracker?.track(signal, 'called');

      if (this.config.enrichEnabled && sent.messageId) {
        void this.upgrade(signal, sent.messageId);
      }
    } catch (err) {
      log.error(`failed to publish ${label(signal)}`, (err as Error).message);
      journal.write('publish-error', { id: signal.id, error: (err as Error).message });
    }
  }

  /** Second pass: replace the message with the enriched version. Failure is harmless. */
  private async upgrade(signal: Signal, messageId: number): Promise<void> {
    const extra = await enrich(signal.call, this.config.enrichTimeoutMs);
    if (!extra || !this.channelPeer) return;

    const enriched: Signal = { ...signal, call: { ...signal.call, ...extra } };
    enriched.timings.enrichedAt = performance.now();
    record('enrich', enriched.timings.enrichedAt - signal.timings.recvAt);

    // The pre-publish screen only had the source's own numbers. This one has the market's,
    // and can compare the two — which is what catches a call that already ran.
    enriched.risk = assess(enriched.call, signal.call.stats.marketCapUsd);
    if (enriched.risk.level === 'danger') {
      log.warn(`⚠️  published ${label(signal)} then found: ${enriched.risk.flags.map((f) => f.detail).join('; ')}`);
    }

    try {
      await editFast(
        this.client,
        this.channelPeer,
        messageId,
        renderPublicCall(enriched, { footer: this.config.footer, showSource: this.config.showSource }),
      );
    } catch (err) {
      log.debug('enrich edit skipped', (err as Error).message);
    }
  }

  private async stage(signal: Signal): Promise<void> {
    if (!this.warRoomPeer) {
      log.warn(`no war room configured; ${label(signal)} from ${signal.source.label} needs review but cannot be shown`);
      return;
    }

    try {
      const sent = await sendFast(this.client, this.warRoomPeer, renderWarRoomCall(signal), {
        stage: 'send.warroom',
      });
      if (sent.messageId) this.staged.set(sent.messageId, { signal, stagedAt: Date.now(), fired: false });
      record('detect-to-warroom', sent.ackAt - signal.timings.recvAt);
      log.info(`🔎 staged ${label(signal)} from ${signal.source.label}`);
      journal.write('staged', this.record(signal));
      this.tracker?.track(signal, 'staged');
    } catch (err) {
      log.error('failed to stage call', (err as Error).message);
    }
  }

  handleReaction(reaction: IncomingReaction): void {
    const staged = this.staged.get(reaction.messageId);
    if (!staged || staged.fired) return;

    if (Date.now() - staged.stagedAt > STAGE_TTL_MS) {
      this.staged.delete(reaction.messageId);
      return;
    }

    if (SKIP.has(reaction.emoji)) {
      staged.fired = true;
      log.info(`⏭️  skipped ${label(staged.signal)}`);
      journal.write('skipped', { id: staged.signal.id });
      return;
    }

    if (!FIRE.has(reaction.emoji)) return;

    staged.fired = true;
    record('approval-latency', reaction.recvAt - staged.signal.timings.recvAt);
    void this.fire(staged.signal);
  }

  /** Drop stale cards so the map cannot grow without bound. */
  sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.staged) {
      if (now - s.stagedAt > STAGE_TTL_MS) this.staged.delete(id);
    }
  }

  private record(signal: Signal): Record<string, unknown> {
    return {
      id: signal.id,
      source: signal.source.id,
      // Kept so `npm run replay` can re-run parser changes against real traffic.
      rawText: signal.rawText,
      chain: signal.call.token.chain,
      address: signal.call.token.address,
      ticker: signal.call.ticker,
      name: signal.call.name,
      origin: signal.call.token.origin,
      confidence: signal.call.token.confidence,
      marketCapUsd: signal.call.stats.marketCapUsd,
      risk: signal.risk.level,
      riskFlags: signal.risk.flags.map((f) => f.code),
      confirmations: signal.confirmations,
      parseMs: signal.timings.parsedAt ? signal.timings.parsedAt - signal.timings.recvAt : undefined,
      ackMs: signal.timings.ackAt ? signal.timings.ackAt - signal.timings.recvAt : undefined,
      messageUnix: signal.timings.messageUnix,
    };
  }
}

function label(signal: Signal): string {
  const t = signal.call.ticker ? `$${signal.call.ticker}` : signal.call.token.address.slice(0, 10);
  return `${t} (${signal.call.token.chain})`;
}
