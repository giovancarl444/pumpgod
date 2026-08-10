import { classifyAddress } from '../parse/addresses';
import type { Intent } from './intent';
import { classify } from './intent';
import type { Knowledge } from './knowledge';
import { answer } from './knowledge';

/**
 * The agent, wired together.
 *
 * One identity, any number of chats — which is what makes "one agent across servers" nearly
 * free once it exists. There is no per-chat state and no per-chat personality; a second group
 * is a second chat id and nothing else.
 *
 * ## Why this one cannot hallucinate
 *
 * Because nothing in it generates. `classify` picks one of a dozen names, `answer` looks the
 * name up, and every figure in the result was read out of the tracker a moment earlier. There
 * is no model in the loop and therefore no step at which a plausible-sounding number can be
 * invented. That is the whole reason this version works where a personality with a memory store
 * does not — and it is also why a generation layer, if one is ever added, has to sit *above*
 * this rather than replace it, with the facts handed to it rather than recalled by it.
 */

export type Surface = 'dm' | 'group';

export interface Ask {
  text: string;
  userId: string;
  chatId: string;
  surface: Surface;
  /**
   * Whether the message was aimed at us — an @mention, or a reply to something we said.
   *
   * Always true in a DM. In a group it is the difference between an asset and an annoyance:
   * a bot that answers questions it was not asked is a bot that gets muted, and then removed.
   */
  addressed: boolean;
}

export interface AgentDeps extends Knowledge {
  /** Replies to one person inside the window. */
  perUser?: number;
  /** Replies into one group inside the window, however many people are asking. */
  perChat?: number;
  windowMs?: number;
  now?: () => number;
}

/**
 * Caps, so cost and noise scale with value rather than with chatter.
 *
 * Low enough that nobody can turn the agent into a wall of text, high enough that a genuine
 * conversation — record, then worst call, then how the screen works — never hits it. Someone
 * who exhausts their allowance is answered with silence rather than a scolding: being told off
 * by a bot is worse than being ignored by one, and the questions are all answered by the pinned
 * board anyway.
 */
const PER_USER = 6;
const PER_CHAT = 12;
const WINDOW_MS = 10 * 60 * 1000;

export interface Reply {
  /**
   * Carried out with the text so the caller can overrule it.
   *
   * The DM surface has a richer answer than this file does for a greeting — it can list the
   * commands that are actually switched on — so it swaps its own in. Handing back the name it
   * matched is how that happens without the surface re-classifying the message and the two
   * quietly disagreeing about what was asked.
   */
  intent: Intent;
  text: string;
}

export interface Agent {
  /** The reply to send, or `undefined` for "say nothing" — which is a real answer in a group. */
  ask(ask: Ask): Reply | undefined;
}

export function createAgent(deps: AgentDeps): Agent {
  const perUser = deps.perUser ?? PER_USER;
  const perChat = deps.perChat ?? PER_CHAT;
  const windowMs = deps.windowMs ?? WINDOW_MS;
  const now = deps.now ?? Date.now;

  const seen = new Map<string, number[]>();

  const allow = (key: string, limit: number): boolean => {
    const at = now();
    const times = (seen.get(key) ?? []).filter((t) => at - t < windowMs);
    if (times.length >= limit) {
      // Written back pruned even on refusal, or a chat that once went over its cap keeps a
      // growing array of expired timestamps for as long as the process lives.
      seen.set(key, times);
      return false;
    }
    times.push(at);
    seen.set(key, times);
    return true;
  };

  return {
    ask(ask: Ask): Reply | undefined {
      const text = ask.text.trim();
      if (!text) return undefined;

      // In a group we speak only when spoken to. See `Ask.addressed`.
      if (ask.surface === 'group' && !ask.addressed) return undefined;

      /**
       * A bare contract address, in a group, is somebody shilling — and an answer of any kind
       * puts our name under their coin. Silence is the only correct response; in a DM the same
       * paste means "do something with this" and is handled by the direct surface instead.
       */
      if (ask.surface === 'group' && classifyAddress(text)) return undefined;

      const intent = classify(text);

      // A greeting in a group, even an addressed one, does not need the full introduction —
      // but a greeting in a DM is somebody who has just found the bot and has nothing else to
      // go on, which is the entire reason the DM surface is open.
      if (intent === 'greeting' && ask.surface === 'group') return undefined;

      if (!allow(`u:${ask.userId}`, perUser)) return undefined;
      if (ask.surface === 'group' && !allow(`c:${ask.chatId}`, perChat)) return undefined;

      return { intent, text: answer(intent, deps) };
    },
  };
}
