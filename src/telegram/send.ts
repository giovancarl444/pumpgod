import { Api, TelegramClient, helpers } from 'telegram';
import { record } from '../metrics/latency';
import { parseHtml } from './html';

export interface SendResult {
  messageId?: number;
  dispatchAt: number;
  ackAt: number;
}

/**
 * The send path is deliberately thin. The peer is a pre-resolved InputPeer so there is
 * no entity lookup, previews are off so the server does no link fetching, and the only
 * work between parsing a call and the socket is building message entities.
 */
export async function sendFast(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  html: string,
  opts: { stage: string; silent?: boolean } = { stage: 'send' },
): Promise<SendResult> {
  const { text, entities } = parseHtml(html);
  const dispatchAt = performance.now();
  const result = await client.invoke(
    new Api.messages.SendMessage({
      peer,
      message: text,
      entities,
      randomId: helpers.generateRandomLong(),
      noWebpage: true,
      silent: opts.silent ?? false,
    }),
  );
  const ackAt = performance.now();
  record(opts.stage, ackAt - dispatchAt);
  return { messageId: extractMessageId(result), dispatchAt, ackAt };
}

export async function editFast(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  messageId: number,
  html: string,
): Promise<void> {
  const { text, entities } = parseHtml(html);
  await client.invoke(
    new Api.messages.EditMessage({ peer, id: messageId, message: text, entities, noWebpage: true }),
  );
}

export function extractMessageId(result: Api.TypeUpdates): number | undefined {
  const updates = result as { updates?: Api.TypeUpdate[]; id?: number };
  if (typeof updates.id === 'number') return updates.id;
  for (const u of updates.updates ?? []) {
    if (u instanceof Api.UpdateMessageID) return u.id;
    if (u instanceof Api.UpdateNewChannelMessage || u instanceof Api.UpdateNewMessage) {
      const m = u.message as Api.Message;
      if (typeof m.id === 'number') return m.id;
    }
  }
  return undefined;
}
