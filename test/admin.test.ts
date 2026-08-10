import { describe, expect, it, vi } from 'vitest';
import { Api, TelegramClient } from 'telegram';
import { AdminCheck } from '../src/telegram/admin';
import type { IncomingCommand } from '../src/telegram/ingest';

const CHANNEL = new Api.InputPeerChannel({ channelId: BigInt(123) as unknown as bigInt.BigInteger, accessHash: BigInt(9) as unknown as bigInt.BigInteger });

function command(over: Partial<IncomingCommand> = {}): IncomingCommand {
  return { text: '/signal x', chatId: '-100123', messageId: 1, post: false, fromChannel: true, recvAt: Date.now(), ...over };
}

/** Answers GetParticipant with whatever rank the test wants, and counts the round trips. */
function harness(participant: Api.TypeChannelParticipant | Error) {
  const invoke = vi.fn(async () => {
    if (participant instanceof Error) throw participant;
    return { participant } as unknown as Api.channels.TypeChannelParticipant;
  });

  const client = {
    invoke,
    getInputEntity: async () => new Api.InputPeerUser({ userId: BigInt(7) as unknown as bigInt.BigInteger, accessHash: BigInt(0) as unknown as bigInt.BigInteger }),
  } as unknown as TelegramClient;

  return { client, invoke };
}

const creator = new Api.ChannelParticipantCreator({ userId: BigInt(7) as unknown as bigInt.BigInteger, adminRights: new Api.ChatAdminRights({}) });
const admin = new Api.ChannelParticipantAdmin({ userId: BigInt(7) as unknown as bigInt.BigInteger, adminRights: new Api.ChatAdminRights({}), promotedBy: BigInt(1) as unknown as bigInt.BigInteger, date: 0 });
const member = new Api.ChannelParticipant({ userId: BigInt(7) as unknown as bigInt.BigInteger, date: 0 });

describe('AdminCheck', () => {
  // In a broadcast channel Telegram already enforces this: only admins can post at all, so
  // the message existing is the proof. Asking again would cost a round trip to learn nothing.
  it('takes a channel post as its own proof, without asking Telegram', async () => {
    const { client, invoke } = harness(member);
    const admins = new AdminCheck(client, CHANNEL);

    expect(await admins.allows(command({ post: true }))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows an admin and the creator of a supergroup', async () => {
    for (const rank of [creator, admin]) {
      const { client } = harness(rank);
      expect(await new AdminCheck(client, CHANNEL).allows(command({ fromId: '7' }))).toBe(true);
    }
  });

  it('refuses an ordinary member who typed the command in the group', async () => {
    const { client } = harness(member);
    expect(await new AdminCheck(client, CHANNEL).allows(command({ fromId: '7' }))).toBe(false);
  });

  it('refuses someone who is not in the group at all', async () => {
    const { client } = harness(new Error('USER_NOT_PARTICIPANT'));
    expect(await new AdminCheck(client, CHANNEL).allows(command({ fromId: '7' }))).toBe(false);
  });

  // An anonymous sender that is not a channel post leaves nobody to check, and publishing
  // is not something to do on an unattributable instruction.
  it('refuses a command it cannot attribute to anyone', async () => {
    const { client, invoke } = harness(admin);
    expect(await new AdminCheck(client, CHANNEL).allows(command({ fromId: undefined }))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  /**
   * An admin posting anonymously in a supergroup is signed by the group, so the sender id is
   * the group's own. Only an admin holding the anonymity right can produce that, which makes
   * it the same free proof a broadcast post gives — and admins of crypto groups routinely
   * post that way. Looked up instead, the group id resolves to no participant and the command
   * goes quietly unanswered, which is the one failure indistinguishable from a dead bot.
   */
  it('takes a message signed by the group itself as an anonymous admin', async () => {
    const { client, invoke } = harness(member);
    const admins = new AdminCheck(client, CHANNEL);

    expect(await admins.allows(command({ fromId: '123' }))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  // A linked broadcast channel auto-forwarding into a discussion group is also signed by a
  // channel — a different one. Only this chat's own id is proof of rights over this chat.
  it('does not extend that to a message signed by some other channel', async () => {
    const { client } = harness(member);
    expect(await new AdminCheck(client, CHANNEL).allows(command({ fromId: '456' }))).toBe(false);
  });

  it('refuses when there is no channel configured to be an admin of', async () => {
    const { client } = harness(admin);
    expect(await new AdminCheck(client, undefined).allows(command({ fromId: '7' }))).toBe(false);
  });

  // Rights change about once a year; a command should not pay for that lookup twice.
  it('asks Telegram once and remembers the answer', async () => {
    const { client, invoke } = harness(admin);
    const admins = new AdminCheck(client, CHANNEL);

    expect(await admins.allows(command({ fromId: '7' }))).toBe(true);
    expect(await admins.allows(command({ fromId: '7' }))).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('caches a refusal too, so a non-admin cannot spend our round trips', async () => {
    const { client, invoke } = harness(member);
    const admins = new AdminCheck(client, CHANNEL);

    for (let i = 0; i < 5; i++) expect(await admins.allows(command({ fromId: '7' }))).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
