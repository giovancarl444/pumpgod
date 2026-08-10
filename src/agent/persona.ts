/**
 * Who the agent is, and the one thing it never does.
 *
 * ## Why this file is constants and not a prompt
 *
 * The usual build of a chat agent is a personality with a memory store: a warm voice, a vector
 * database, and a generation step that is free to say anything the two of them suggest. That
 * shape produces confident nonsense. It retrieves something that merely *sounds* related, says
 * it in a friendly tone, and nothing anywhere in the loop ever tells it that it was wrong. It
 * drifts a little every message, and in a channel about money it eventually states a number
 * that is false — in writing, at scale, to somebody who acted on it.
 *
 * What is built here is the other thing: a spokesperson with a database. The persona is fixed
 * because a persona that can move is a persona that will. Every answer it can give is a
 * function in `knowledge.ts`, and every number in every answer is read from the tracker rather
 * than produced by anything. There is no general path, which is the entire point — an agent
 * that can answer anything is an agent that can be wrong about anything.
 *
 * We are unusually well placed for this, because the hard half already exists. The agent does
 * not have to guess how we performed. It can look it up.
 */

/** The name it answers to, and the name in its own sentences. */
export const NAME = 'pumpgod';

/**
 * The boundary, stated once so that every other file can point at it.
 *
 * **It talks about us and our record. It never says whether a coin will go up.**
 *
 * This is not politeness and it is not a limitation to route around in a later version. A bot
 * that gives financial advice — wrong, in writing, at scale, to strangers — is the single
 * liability that can end the channel, and it would arrive dressed as helpfulness. Everything on
 * our side of the line is a fact anybody can check. Everything on the far side is a prediction
 * nobody can, including us.
 *
 * The check runs *before* the question is classified, not after, so a message that smuggles a
 * forbidden question in behind a legitimate one is refused rather than half-answered.
 */
export const BOUNDARY =
  'I only talk about calls we have already made and how they turned out. ' +
  'I will not tell you whether a coin is going to go up — nobody can, and a bot saying so ' +
  'would be worth exactly nothing to you.';

/**
 * What it says when a question is outside the set.
 *
 * A first-class answer rather than a fallback. The whole design rests on the answer set being
 * bounded, and a bounded set is only honest if stepping outside it is visible. An agent that
 * improvises past its own edge has no edge.
 */
export const UNKNOWN =
  "I don't know that one, and I'd rather say so than guess. " +
  'Ask me about our track record, how we screen a coin, or how the channel works.';

/**
 * The half-sentence that goes under a number when the sample is too thin to mean anything.
 *
 * Quoting a hit rate off four calls is the exact trick every group in this space runs, and any
 * sharp reader spots it instantly. Saying it ourselves, unprompted, costs one line and buys the
 * only thing we are actually selling.
 */
export const THIN_SAMPLE = 'Small sample so far — treat it as early, not as a track record.';

/**
 * Priced calls before a rate is quoted without a caveat.
 *
 * The same 20 the source scorecard uses, and for the same reason: below it a hit rate is noise
 * wearing a statistic's clothes.
 */
export const MIN_SAMPLE = 20;
