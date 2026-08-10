import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Api, TelegramClient } from 'telegram';
import { ROOT } from '../config';
import type { Source } from '../types';
import type { IncomingMessage } from './ingest';
import { log } from '../log';

const CURSORS = resolve(ROOT, 'data/cursors.json');

/** Bounded so a long outage cannot flood the war room with hours of stale calls. */
const MAX_BACKFILL = 40;

export interface WatchedPeer {
  source: Source;
  peer: Api.TypeInputPeer;
}

/**
 * MTProto delivers updates over a socket that can drop, and GramJS's own gap recovery does
 * not guarantee every message in the gap is replayed. A missed call is worse than a slow
 * one, so we track the last message id seen per chat and explicitly pull anything newer
 * on a timer. One cheap request per source per sweep buys certainty.
 */
export class Catchup {
  private readonly cursors = new Map<string, number>();
  private dirty = false;

  constructor(private readonly client: TelegramClient) {}

  load(): void {
    if (!existsSync(CURSORS)) return;
    try {
      const raw = JSON.parse(readFileSync(CURSORS, 'utf8')) as Record<string, number>;
      for (const [k, v] of Object.entries(raw)) this.cursors.set(k, v);
      log.debug(`restored ${this.cursors.size} cursors`);
    } catch (err) {
      log.warn(`could not read cursors, starting fresh: ${(err as Error).message}`);
    }
  }

  /** Called for every message on the hot path, so it does nothing but a Map write. */
  note(chatId: string, messageId: number): void {
    const current = this.cursors.get(chatId);
    if (current === undefined || messageId > current) {
      this.cursors.set(chatId, messageId);
      this.dirty = true;
    }
  }

  persist(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(resolve(ROOT, 'data'), { recursive: true });
      writeFileSync(CURSORS, JSON.stringify(Object.fromEntries(this.cursors), null, 2));
    } catch (err) {
      log.warn(`could not persist cursors: ${(err as Error).message}`);
    }
  }

  /**
   * Returns anything that arrived while we were not listening, oldest first so the
   * router sees it in the order the source posted it.
   */
  async sweep(watched: Map<string, WatchedPeer>): Promise<IncomingMessage[]> {
    const missed: IncomingMessage[] = [];

    for (const [chatId, { source, peer }] of watched) {
      const since = this.cursors.get(chatId);
      if (since === undefined) {
        // First sight of this chat: anchor on the newest message rather than replaying
        // history we were never meant to act on.
        try {
          const [latest] = await this.client.getMessages(peer, { limit: 1 });
          if (latest) this.cursors.set(chatId, latest.id);
          this.dirty = true;
        } catch (err) {
          log.debug(`anchor failed for ${source.label}: ${(err as Error).message}`);
        }
        continue;
      }

      try {
        const messages = await this.client.getMessages(peer, { limit: MAX_BACKFILL, minId: since });
        if (!messages.length) continue;

        const recvAt = performance.now();
        for (const message of [...messages].reverse()) {
          if (!(message instanceof Api.Message) || !message.message) continue;
          missed.push({
            source,
            chatId,
            messageId: message.id,
            text: message.message,
            entities: message.entities,
            messageUnix: message.date,
            recvAt,
            isEdit: false,
          });
          this.note(chatId, message.id);
        }
        log.warn(`recovered ${messages.length} missed message(s) from ${source.label}`);
      } catch (err) {
        log.debug(`catchup failed for ${source.label}: ${(err as Error).message}`);
      }
    }

    this.persist();
    return missed;
  }
}
