import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ROOT, type CompetitionConfig } from '../config';
import { renderLeaderboard } from '../format/leaderboard';
import { renderScoreboard } from '../format/scoreboard';
import type { MemberHandlers } from '../pipeline/member';
import { scoreboard } from '../track/stats';
import type { TrackedCall } from '../track/tracker';
import type { Peer, Transport } from '../telegram/transport';
import { log } from '../log';

export const STORE = resolve(ROOT, 'data/scoreboard.json');
export const BOARD_STORE = resolve(ROOT, 'data/leaderboard.json');

/**
 * What a given pinned message *is*. Everything else about keeping one — remembering where it
 * lives, refusing to edit a message id in a chat it does not belong to, skipping an edit that
 * would change nothing — is identical whichever message it is, so it is written once.
 */
export interface PinnedKind {
  /** Named in the log lines, so two of these are tellable apart at three in the morning. */
  what: string;
  /** The one-shot that creates it, quoted when there is nothing to edit yet. */
  script: string;
  /** `undefined` when there is nothing worth saying, which leaves the message as it was. */
  render(calls: TrackedCall[]): string | undefined;
}

export const TRACK_RECORD: PinnedKind = {
  what: 'track record',
  script: 'npm run scoreboard',
  render: (calls) => renderScoreboard(scoreboard(calls)),
};

/**
 * The competition table, in the channel rather than only in a DM.
 *
 * That is the whole growth loop. A leaderboard you have to message a bot to see is read by the
 * people already playing; one pinned above the feed is read by everyone who is not, which is
 * the only audience that matters — it is the message that turns a lurker into an entrant.
 *
 * Renders even with nobody on it, unlike the track record: an empty table says how to enter,
 * and there is no claim in it to be premature about.
 */
export function competitionBoard(member: MemberHandlers, comp: CompetitionConfig): PinnedKind {
  return {
    what: 'leaderboard',
    script: 'npm run leaderboard',
    render: (calls) => renderLeaderboard(member.leaderboard(calls), comp),
  };
}

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
    log.warn(`could not read ${store}: ${(err as Error).message}`);
    return undefined;
  }
}

export function writePinned(state: PinnedState, store = STORE): void {
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, JSON.stringify(state, null, 2));
}

/**
 * Keeps one pinned message current — by default the record of every call we have made.
 *
 * It edits rather than reposts, so the message has a single permanent home a newcomer can read
 * before deciding whether to trust anything else in the channel — and so that improving it is
 * never the same as spamming.
 *
 * Creating and pinning it is a one-shot job (`npm run scoreboard`), deliberately not done
 * here: pinning is not on `Transport`, and a daemon that can pin is a daemon that can pin
 * the wrong thing at four in the morning.
 */
export class Pinned {
  private state?: PinnedState;

  constructor(
    private readonly store = STORE,
    private readonly kind: PinnedKind = TRACK_RECORD,
  ) {}

  load(): void {
    this.state = readPinned(this.store);
    if (!this.state) log.info(`no pinned ${this.kind.what} yet — create one with \`${this.kind.script}\``);
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
      log.warn(`the pinned ${this.kind.what} is in ${this.state.chatId}, not ${peer.id} — leaving it alone`);
      this.state = undefined;
      return;
    }

    const text = this.kind.render(calls);
    if (!text || text === this.state.lastText) return;

    try {
      await transport.edit(peer, this.state.messageId, text);
      this.state.lastText = text;
      writePinned(this.state, this.store);
    } catch (err) {
      log.warn(`could not update the pinned ${this.kind.what}: ${(err as Error).message}`);
    }
  }
}
