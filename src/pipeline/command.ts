import { Api, TelegramClient } from 'telegram';
import type { AppConfig } from '../config';
import { escapeHtml } from '../format/call';
import { AdminCheck, deleteMessage } from '../telegram/admin';
import type { IncomingCommand } from '../telegram/ingest';
import { sendFast } from '../telegram/send';
import { log } from '../log';
import { parseCommand, resolveManualCall } from './manual';
import type { Router } from './router';

export interface CommandDeps {
  client: TelegramClient;
  config: AppConfig;
  router: Router;
  admins: AdminCheck;
  channelPeer?: Api.TypeInputPeer;
  warRoomPeer?: Api.TypeInputPeer;
}

/**
 * `/signal <address>` from end to end: rights, deleting the instruction, resolving market
 * data, routing, and answering.
 *
 * A module rather than a closure inside `main` because this is the path that runs the first
 * time somebody types the command, and a closure can only be proven by having the credentials
 * to run it. Assembled from real collaborators here, it can be driven by a test that mocks
 * nothing but the Telegram socket and the market.
 */
export function createCommandHandler(deps: CommandDeps): (cmd: IncomingCommand) => Promise<void> {
  const { client, config, router, admins, channelPeer, warRoomPeer } = deps;

  // The war room takes every reply it can, because the public channel should carry calls and
  // nothing else — a member scrolling past "✗ no pool found" learns only that we fumbled.
  // With no war room configured there is nowhere else to answer, and silence after a command
  // that deleted itself is worse than the clutter, so it goes back to the channel.
  const say = async (text: string, cmd: IncomingCommand) => {
    const peer = warRoomPeer ?? (cmd.fromChannel ? channelPeer : undefined);
    if (!peer) return;
    await sendFast(client, peer, text, { stage: 'send.warroom' }).catch(() => undefined);
  };

  return async (cmd: IncomingCommand) => {
    const argument = parseCommand(cmd.text);
    if (!argument) return;

    if (cmd.fromChannel) {
      if (!(await admins.allows(cmd))) {
        log.warn(`ignored /signal from a non-admin in the channel (${cmd.fromId ?? 'unknown'})`);
        return;
      }
      // Take the instruction down first. If resolving is slow, the channel should not be
      // sitting there showing the command while it waits.
      if (channelPeer) {
        await deleteMessage(client, channelPeer, cmd.messageId).catch((err: Error) =>
          log.debug(`could not delete the command message: ${err.message}`),
        );
      }
    }

    // Resolving market data first is what makes this callable at all: an address on its own
    // has no numbers for the screen to read. Nobody is being raced, so the hop is free.
    const outcome = await resolveManualCall(argument, Math.max(config.enrichTimeoutMs, 5000), config.chains);
    if (!outcome.ok) {
      log.warn(`manual call rejected: ${outcome.reason}`);
      await say(`✗ ${escapeHtml(outcome.reason)}`, cmd);
      return;
    }

    const ticker = outcome.call.ticker ? `$${escapeHtml(outcome.call.ticker)}` : 'that coin';
    const decision = router.callManual(outcome.call, cmd.text, cmd.recvAt);

    // Every branch answers. The command deleted itself on the way in, so an unreported
    // decision leaves an admin unable to tell a screened coin from a bot that has died.
    switch (decision.kind) {
      case 'publishing':
        if (!config.live) await say(`🔇 LIVE=false — ${ticker} was not published.`, cmd);
        // The card carries the flag itself, so repeating it is only worth doing somewhere
        // private — saying it in the channel would tell members what they can already read.
        else if (decision.flagged && warRoomPeer) {
          await sendFast(client, warRoomPeer, `🚨 ${ticker} published anyway — ${escapeHtml(decision.flagged)}`, {
            stage: 'send.warroom',
          }).catch(() => undefined);
        }
        break;
      case 'review':
        await say(
          `⚠️ ${ticker} was held back: ${escapeHtml(decision.reason)}.` +
            (warRoomPeer ? ' Tap 🚀 on the card below to publish it anyway.' : ''),
          cmd,
        );
        break;
      case 'duplicate':
        await say(`↩︎ ${ticker} was already called (${escapeHtml(decision.sources.join(', '))}).`, cmd);
        break;
      case 'dropped':
        await say(`✗ ${ticker}: ${escapeHtml(decision.reason)}`, cmd);
        break;
    }
  };
}
