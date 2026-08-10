import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT } from '../config';
import { renderScoreboard } from '../format/scoreboard';
import { scoreboard } from '../track/stats';
import type { TrackedCall } from '../track/tracker';
import type { Peer, Transport } from '../telegram/transport';
import { log } from '../log';

export const STORE = resolve(ROOT, 'data/scoreboard.json');

export interface PinnedState {
  chatId: string;
  messageId: number;
  /**
   * The text as we last sent it. Telegram rejects an edit that changes nothing, and the board
   * only moves when a price does — so without this the log fills with 400s forever.
   */
  lastText: string;
}

export function readPinned(store = STORE): PinnedState | undefined {
  if (!existsSync(store)) return undefined;
  try {
    return JSON.parse(readFileSync(store, 'utf8')) as PinnedState;
  } catch (err) {
    log.warn(`could not read the pinned track record: ${(err as Error).message}`);
    return undefined;
  }
}

export function writePinned(state: PinnedState, store = STORE): void {
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify(state, null, 2));
}

/**
 * Keeps one pinned message telling the truth about every call we have made.
 *
 * It edits rather than reposts, so the record has a single permanent home a newcomer can read
 * before deciding whether to trust anything else in the channel — and so that improving it is
 * never the same as spamming.
 *
 * Creating and pinning it is a one-shot job (`npm run scoreboard`), deliberately not done
 * here: pinning is not on `Transport`, and a daemon that can pin is a daemon that can pin
 * the wrong thing at four in the morning.
 */
export class Pinned {
  private state?: PinnedState;

  constructor(private readonly store = STORE) {}

  load(): void {
    this.state = readPinned(this.store);
    if (!this.state) log.info('no pinned track record yet — create one with `npm run scoreboard`');
  }

  get live(): boolean {
    return this.state !== undefined;
  }

  async refresh(transport: Transport, peer: Peer, calls: TrackedCall[]): Promise<void> {
    if (!this.state) return;

    // That message id names a message in one specific chat. Editing the same number in a
    // different one rewrites whatever happens to be there, so a repointed channel stops the
    // board instead of gambling with a real post.
    if (this.state.chatId !== peer.id) {
      log.warn(`the pinned track record is in ${this.state.chatId}, not ${peer.id} — leaving it alone`);
      this.state = undefined;
      return;
    }

    const text = renderScoreboard(scoreboard(calls));
    if (!text || text === this.state.lastText) return;

    try {
      await transport.edit(peer, this.state.messageId, text);
      this.state.lastText = text;
      writePinned(this.state, this.store);
    } catch (err) {
      log.warn(`could not update the pinned track record: ${(err as Error).message}`);
    }
  }
}
