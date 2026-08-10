import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { ConnectionTCPAbridged } from 'telegram/network';
import { log } from '../log';

export interface ClientOptions {
  apiId: number;
  apiHash: string;
  session: string;
}

/**
 * Abridged framing has the smallest per-packet header of the MTProto transports, and a
 * raw TCP socket avoids the WebSocket handshake and masking that `useWSS` would add.
 * Neither is huge on its own, but this connection carries every call we make.
 */
export function createClient(opts: ClientOptions): TelegramClient {
  return new TelegramClient(new StringSession(opts.session), opts.apiId, opts.apiHash, {
    connection: ConnectionTCPAbridged,
    useWSS: false,
    connectionRetries: 10,
    retryDelay: 500,
    autoReconnect: true,
    requestRetries: 2,
    // Nothing in the hot path needs message history, and letting GramJS fetch it would
    // put a network round trip between us and a call.
    sequentialUpdates: false,
    floodSleepThreshold: 60,
    baseLogger: undefined,
  });
}

/**
 * Resolving a peer normally costs a round trip. Pulling the dialog list once at boot
 * caches every access_hash we need, so later resolution is pure memory.
 */
export async function primeEntityCache(client: TelegramClient): Promise<number> {
  const dialogs = await client.getDialogs({ limit: 500 });
  log.debug(`entity cache primed with ${dialogs.length} dialogs`);
  return dialogs.length;
}

export async function resolveInputPeer(
  client: TelegramClient,
  target: string,
): Promise<Api.TypeInputPeer> {
  const trimmed = target.trim();
  if (!trimmed) throw new Error('Cannot resolve an empty peer.');

  // A bare numeric id is a channel id; GramJS wants the -100 form to disambiguate it
  // from a user id.
  const asChannel = /^-?\d+$/.test(trimmed)
    ? Number(trimmed) > 0
      ? `-100${trimmed}`
      : trimmed
    : trimmed;

  return (await client.getInputEntity(asChannel)) as Api.TypeInputPeer;
}

/** Bare channel id used as the key for watched-source lookups on the hot path. */
export function peerIdOf(peer: Api.TypeInputPeer): string | undefined {
  if (peer instanceof Api.InputPeerChannel) return peer.channelId.toString();
  if (peer instanceof Api.InputPeerChat) return peer.chatId.toString();
  if (peer instanceof Api.InputPeerUser) return peer.userId.toString();
  return undefined;
}
