import type { AppConfig } from '../config';
import type { ParsedCall, Signal, Source } from '../types';
import { parseCall } from '../parse';
import { callButtons, renderPublicCall, renderWarRoomCall } from '../format/call';
import type { Peer, Transport } from '../telegram/transport';
import type { IncomingMessage, IncomingReaction } from '../telegram/ingest';
import { Dedupe } from './dedupe';
import { enrich } from './enrich';
import { MANUAL_SOURCE } from './manual';
import { assess, headlineFlag, unsellable } from './risk';
import { record } from '../metrics/latency';
import { journal } from '../store/journal';
import { Tracker } from '../track/tracker';
import { log } from '../log';

export const FIRE = new Set(['🚀', '🔥', '⚡', '👍', '✅', '💎']);
export const SKIP = new Set(['👎', '❌', '🤡', '💩']);

/**
 * The per-source gates from `config/sources.json`. Module-level so `npm run drill` can ask
 * whether its test call would survive them rather than keeping a copy that drifts.
 */
export function passesFilters(source: Source, call: ParsedCall): boolean {
  if (source.chains?.length && !source.chains.includes(call.token.chain)) return false;

  const mc = call.stats.marketCapUsd;
  if (mc !== undefined) {
    if (source.minMarketCapUsd !== undefined && mc < source.minMarketCapUsd) return false;
    if (source.maxMarketCapUsd !== undefined && mc > source.maxMarketCapUsd) return false;
  }
  return true;
}

/** War-room cards expire so a stale reaction cannot fire a call from an hour ago. */
const STAGE_TTL_MS = 30 * 60_000;

interface Staged {
  signal: Signal;
  stagedAt: number;
  fired: boolean;
}

/**
 * What routing decided about a call.
 *
 * A relayed call ignores this — there is nobody to tell. A call somebody typed cannot: an
 * admin who runs `/signal` and gets silence has no way to distinguish "held back because the
 * pool is thin" from "the bot is down", and the command message has already been deleted by
 * then. Every path out of `route` therefore names itself.
 */
export type RouteDecision =
  /** `flagged` is set when the screen objected but the call went out regardless. */
  | { kind: 'publishing'; flagged?: string }
  | { kind: 'review'; reason: string }
  | { kind: 'duplicate'; sources: string[] }
  | { kind: 'dropped'; reason: string };

/** A call ready to be judged, however we came by it. */
export interface RouteInput {
  source: Source;
  call: ParsedCall;
  /** Provenance. A Telegram chat and message id, or a detector id and 0. */
  chatId: string;
  messageId: number;
  /** What `npm run replay` re-parses. Empty for on-chain detections — there was no text. */
  rawText: string;
  /** Unix seconds this originated: when the group posted, or when the pool was created. */
  originUnix: number;
  recvAt: number;
  parsedAt: number;
  /** Stats already carry live market data, so publishing must not re-fetch them. */
  enriched?: boolean;
}

export class Router {
  private readonly dedupe: Dedupe;
  private readonly staged = new Map<number, Staged>();
  private counter = 0;

  constructor(
    private readonly transport: Transport,
    private readonly config: AppConfig,
    private readonly channelPeer: Peer | undefined,
    private readonly warRoomPeer: Peer | undefined,
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

    this.route({
      source: incoming.source,
      call,
      chatId: incoming.chatId,
      messageId: incoming.messageId,
      rawText: incoming.text,
      originUnix: incoming.messageUnix,
      recvAt: incoming.recvAt,
      parsedAt,
    });
  }

  /**
   * Everything after "we are holding a call": dedupe, filters, screening, routing. Shared so
   * a token detected on-chain goes through exactly the same gates as one lifted out of a
   * Telegram message — the checks that protect the channel should not depend on how we
   * heard about the coin.
   */
  route(input: RouteInput): RouteDecision {
    const { source, call } = input;

    // Ahead of the per-source filters because this one is not a preference — it is the set
    // of chains we can price, screen and route a buy on. A call we cannot check is one we
    // cannot stand behind, whichever source it came from and however we were told about it.
    if (this.config.chains.length && !this.config.chains.includes(call.token.chain)) {
      log.debug(`skipped ${call.token.address} on ${call.token.chain} — not in CHAINS`);
      return { kind: 'dropped', reason: `${call.token.chain} is not a chain we call` };
    }
    if (!passesFilters(source, call)) {
      return { kind: 'dropped', reason: `filtered out by source "${source.id}"` };
    }

    // A group we only watch registers here but must not claim the coin: it has nowhere to
    // send a call, so if it took the slot our own call would be dropped as a duplicate of a
    // post that was never made. That failure scales with the number of rivals we track, and
    // tracking all of them is the plan.
    const { first, entry } = this.dedupe.check(
      call.token.chain,
      call.token.address,
      source.id,
      source.mode !== 'shadow',
    );

    // Seconds since this originated: when a group posted it, or when the pool was created.
    // Coarse either way, but it only needs to separate "just now" from "we were late".
    const ageSec = Math.max(0, Math.round(Date.now() / 1000 - input.originUnix));

    const signal: Signal = {
      id: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`,
      source,
      chatId: input.chatId,
      messageId: input.messageId,
      rawText: input.rawText,
      call,
      confirmations: entry.sources,
      ageSec,
      stale: ageSec > this.config.maxCallAgeSec,
      // Pure arithmetic on numbers we already hold — sub-microsecond, so it can gate the
      // publish. Re-read against real market data in `upgrade`.
      risk: assess(call, undefined, input.enriched),
      enriched: input.enriched,
      timings: {
        messageUnix: input.originUnix,
        recvAt: input.recvAt,
        parsedAt: input.parsedAt,
        wallClockMs: Date.now(),
      },
    };

    if (!first) {
      // How far behind the first group this one was. Only derivable here: `firstSeen` is gone
      // once the dedupe window rolls over, and it is the whole basis for "we posted it at
      // $41K, three groups followed over the next 22 minutes".
      const leadMs = Date.now() - entry.firstSeen;
      log.debug(`dup ${call.token.address} (${entry.sources.join(', ')}) +${Math.round(leadMs / 1000)}s`);
      journal.write('duplicate', {
        id: signal.id,
        source: source.id,
        chain: call.token.chain,
        address: call.token.address,
        first: entry.sources[0],
        leadMs,
      });
      // Tracked against its own source rather than dropped. A group that called this twenty
      // minutes late gets the entry it actually gave — which is exactly what a table
      // comparing them is supposed to show.
      this.tracker?.track(signal, 'duplicate');
      return { kind: 'duplicate', sources: entry.sources };
    }

    if (source.mode === 'shadow') {
      log.info(`👻 shadow ${label(signal)} from ${source.label}`);
      journal.write('shadow', this.record(signal));
      // Tracked anyway — knowing what a source *would* have made us is the whole
      // reason shadow mode exists.
      this.tracker?.track(signal, 'shadow');
      return { kind: 'dropped', reason: `source "${source.id}" is in shadow mode` };
    }

    // Two things override a source's mode, both for the same reason: publishing them as
    // ordinary calls is how a call group loses trust. A stale call is one we recovered after
    // an outage or were too slow to see. A dangerous one is untradable — no exit liquidity,
    // an unbacked price, or a move that already happened. Neither is auto-published.
    //
    // Unless somebody typed the address. `/signal` exists so that discussing a coin and
    // calling it are separate acts, which makes the command the decision — and asking for it
    // twice is how an admin's call goes quiet instead of out, since the second confirmation
    // lives in a war room that is optional and may not be there to hold it. The screen is
    // not silenced: its flags ride on the card, and `flagged` carries them back to the admin.
    //
    // With one exception, and it is the only thing a command cannot wave through. Every other
    // flag is a matter of degree that an admin can reasonably overrule — they may know the pool
    // is thin and be calling it anyway. A live freeze or mint authority is not a judgement about
    // how good the coin is: it is the chain stating that one key holder decides whether anybody
    // who buys is allowed to sell. Publishing that on command would put a card in the channel
    // whose own warning line explains why it should not have been posted.
    const flagged = dangerDetail(signal);
    const waivedByCommand = source.commanded && !unsellable(signal.risk.flags);
    const divert = (signal.stale || signal.risk.level === 'danger') && !waivedByCommand;
    if (source.mode === 'auto' && !divert) {
      if (flagged) log.warn(`⚠️  publishing ${label(signal)} on command despite: ${flagged}`);
      void this.fire(signal);
      return { kind: 'publishing', flagged };
    }

    if (signal.stale) log.warn(`⏳ ${label(signal)} is ${signal.ageSec}s old — routing to review`);
    if (signal.risk.level === 'danger') {
      log.warn(`⚠️  ${label(signal)} — ${signal.risk.flags.map((f) => f.detail).join('; ')}`);
      // Only for an auto source, because only there did anything actually decide. This call
      // was on its way to the channel and the screen stopped it. A review source was always
      // going to the war room, and arriving there is not a judgement anybody made.
      if (source.mode === 'auto') {
        this.tracker?.decline(signal, signal.risk.flags.find((f) => f.level === 'danger')?.detail);
      }
    }
    void this.stage(signal);
    return { kind: 'review', reason: reviewReason(signal, source) };
  }

  /**
   * A call we made ourselves, from an address handed straight to us. Market data was
   * resolved before this point, so it arrives at the same gates a relayed call reaches —
   * dedupe, screening, publish — already carrying real numbers to be judged on.
   */
  callManual(call: ParsedCall, rawText: string, recvAt: number): RouteDecision {
    const now = performance.now();
    return this.route({
      source: MANUAL_SOURCE,
      call,
      chatId: 'manual',
      messageId: 0,
      rawText,
      originUnix: Math.floor(Date.now() / 1000),
      recvAt,
      parsedAt: now,
      enriched: true,
    });
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
      const html = renderPublicCall(signal, this.config);
      const keyboard = callButtons(signal, this.config);
      // A relayed call has no artwork yet — it arrives as text from another group, and the
      // image only exists once enrichment has been to the market. So this attaches a photo
      // for calls we resolved up front, and stays a plain fast send for the ones we are
      // racing somebody on. That is the right trade in both directions.
      const image = this.config.showImage ? signal.call.imageUrl : undefined;
      const sent = image
        ? await this.transport.sendPhoto(this.channelPeer, image, html, {
            stage: 'send.public',
            timeoutMs: this.config.enrichTimeoutMs,
            keyboard,
          })
        : await this.transport.send(this.channelPeer, html, { stage: 'send.public', keyboard });

      signal.timings.dispatchAt = sent.dispatchAt;
      signal.timings.ackAt = sent.ackAt;
      record('detect-to-ack', sent.ackAt - signal.timings.recvAt);
      record('detect-to-dispatch', sent.dispatchAt - signal.timings.recvAt);

      if (sent.messageId) this.dedupe.markPublished(signal.call.token.chain, signal.call.token.address, sent.messageId);

      log.info(
        `🚀 CALLED ${label(signal)} · ${(sent.ackAt - signal.timings.recvAt).toFixed(1)}ms end-to-end`,
      );
      journal.write('called', this.record(signal));
      const tracked = this.tracker?.track(signal, 'called');
      // Remembered here because this is the only point that holds both the coin and where its
      // card landed. Without it a milestone can only be announced as a fresh message, which
      // asks the reader to take the entry price on trust instead of scrolling up to it.
      if (tracked && sent.messageId) {
        this.tracker?.published(tracked, this.channelPeer.id, sent.messageId, this.channelPeer.threadId);
      }

      if (this.config.enrichEnabled && sent.messageId && !signal.enriched) {
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
    enriched.risk = assess(enriched.call, signal.call.stats.marketCapUsd, true);
    if (enriched.risk.level === 'danger') {
      log.warn(`⚠️  published ${label(signal)} then found: ${enriched.risk.flags.map((f) => f.detail).join('; ')}`);
    }

    try {
      // The keyboard goes back with the text, or this edit takes the Buy button off a card
      // that has been live for all of two seconds.
      await this.transport.edit(this.channelPeer, messageId, renderPublicCall(enriched, this.config), {
        keyboard: callButtons(enriched, this.config),
      });
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
      const sent = await this.transport.send(this.warRoomPeer, renderWarRoomCall(signal, this.config), {
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
      // Somebody read this card and said no. That is the only thing that makes a later "we
      // passed on this" post true rather than a card nobody opened.
      this.tracker?.decline(staged.signal, headlineFlag(staged.signal.risk.flags)?.detail);
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

/**
 * Why a call went to review rather than the channel. Reads the screen's own wording, so the
 * admin is told the same thing the war-room card shows rather than a second paraphrase of it
 * that can drift.
 */
/** What the screen objected to, in the words it would use to a human. */
function dangerDetail(signal: Signal): string | undefined {
  const details = signal.risk.flags.filter((f) => f.level === 'danger').map((f) => f.detail);
  return details.length ? details.join('; ') : undefined;
}

function reviewReason(signal: Signal, source: Source): string {
  const reasons = signal.risk.flags.filter((f) => f.level === 'danger').map((f) => f.detail);
  if (signal.stale) reasons.push(`it is ${signal.ageSec}s old`);
  // Neither gate fired, so the source is simply set to be approved by hand.
  if (!reasons.length) reasons.push(`source "${source.id}" is set to manual review`);
  return reasons.join('; ');
}
