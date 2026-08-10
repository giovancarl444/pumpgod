export interface Verb {
  /** Lower-cased, without the slash or the `@thebot` suffix. */
  name: string;
  /** Everything that followed it, trimmed. Empty when there was nothing. */
  rest: string;
}

/**
 * The command word at the front of a message, and whatever came after it.
 *
 * A leading slash is **required** here, unlike `parseCommand` on the manual path. That is the
 * difference between a conversation and a console: the war room is somewhere coins get
 * discussed, so `signal <address>` without a slash is a convenience there. A DM to the bot is
 * a list of commands, and a surface that guesses would read a pasted address as a submission
 * and a question about the leaderboard as a request for it.
 *
 * Telegram's `@thebot` suffix is stripped for the same reason `/signal@pumpgodbot` works —
 * tapping a command out of the autocomplete has to do what typing it does.
 */
export function parseVerb(text: string): Verb | undefined {
  const match = /^\s*\/([a-z0-9_]+)(?:@\w+)?(?:\b[\s:]*|$)/i.exec(text);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase(), rest: text.slice(match[0].length).trim() };
}
