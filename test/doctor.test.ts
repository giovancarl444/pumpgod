import { describe, expect, it } from 'vitest';
import { Api, TelegramClient } from 'telegram';
import bigInt from 'big-integer';
import { credentialChecks, postRights, reactionCheck, signalRights } from '../scripts/doctor';

/**
 * The doctor only has value if its verdicts are right. Every case here is a real
 * misconfiguration that Telegram reports without any error — the wrong branch would
 * hand back a ✓ for a channel that silently swallows every call.
 */

const BASE = { photo: new Api.ChatPhotoEmpty(), date: 0 };

function channel(fields: Partial<ConstructorParameters<typeof Api.Channel>[0]>): Api.Channel {
  return new Api.Channel({ id: bigInt(1), title: 'dest', ...BASE, ...fields });
}

function chat(fields: Partial<ConstructorParameters<typeof Api.Chat>[0]>): Api.Chat {
  return new Api.Chat({ id: bigInt(1), title: 'dest', participantsCount: 3, version: 1, ...BASE, ...fields });
}

function fullChat(availableReactions?: Api.TypeChatReactions): TelegramClient {
  return { invoke: async () => ({ fullChat: { availableReactions } }) } as unknown as TelegramClient;
}

const PEER = new Api.InputPeerSelf();

describe('postRights on a broadcast channel', () => {
  it('passes an admin who can post', () => {
    const entity = channel({ broadcast: true, adminRights: new Api.ChatAdminRights({ postMessages: true }) });
    expect(postRights(entity).status).toBe('ok');
  });

  it('passes the creator', () => {
    expect(postRights(channel({ broadcast: true, creator: true })).status).toBe('ok');
  });

  // The headline case: subscribing to your own channel looks identical to being able to
  // post in it, right up until the first call is rejected.
  it('fails a plain subscriber', () => {
    const check = postRights(channel({ broadcast: true }));
    expect(check.status).toBe('fail');
    expect(check.hint).toMatch(/admin/i);
  });

  it('fails an admin without the post right', () => {
    const entity = channel({ broadcast: true, adminRights: new Api.ChatAdminRights({ banUsers: true }) });
    expect(postRights(entity).status).toBe('fail');
  });

  it('fails a channel this account has left', () => {
    expect(postRights(channel({ broadcast: true, creator: true, left: true })).status).toBe('fail');
  });
});

describe('postRights on a supergroup', () => {
  it('passes an ordinary member', () => {
    expect(postRights(channel({ megagroup: true })).status).toBe('ok');
  });

  it('fails when members are muted by default', () => {
    const entity = channel({
      megagroup: true,
      defaultBannedRights: new Api.ChatBannedRights({ sendMessages: true, untilDate: 0 }),
    });
    expect(postRights(entity).status).toBe('fail');
  });

  it('passes an admin even when members are muted by default', () => {
    const entity = channel({
      megagroup: true,
      adminRights: new Api.ChatAdminRights({ deleteMessages: true }),
      defaultBannedRights: new Api.ChatBannedRights({ sendMessages: true, untilDate: 0 }),
    });
    expect(postRights(entity).status).toBe('ok');
  });

  it('fails when this account alone is restricted', () => {
    const entity = channel({ megagroup: true, bannedRights: new Api.ChatBannedRights({ sendPlain: true, untilDate: 0 }) });
    expect(postRights(entity).status).toBe('fail');
  });
});

describe('postRights on a basic group', () => {
  it('passes a member', () => {
    expect(postRights(chat({})).status).toBe('ok');
  });

  it('fails a group that was upgraded to a supergroup', () => {
    const entity = chat({ deactivated: true, migratedTo: new Api.InputChannel({ channelId: bigInt(2), accessHash: bigInt(0) }) });
    const check = postRights(entity);
    expect(check.status).toBe('fail');
    expect(check.hint).toMatch(/dialogs/);
  });

  it('fails a group this account has left', () => {
    expect(postRights(chat({ left: true })).status).toBe('fail');
  });
});

describe('postRights on a chat we cannot see', () => {
  it('fails a forbidden channel', () => {
    expect(postRights(new Api.ChannelForbidden({ id: bigInt(1), accessHash: bigInt(0), title: 'x' })).status).toBe('fail');
  });

  it('warns when the destination is a user, not a channel', () => {
    expect(postRights(new Api.User({ id: bigInt(1) })).status).toBe('warn');
  });
});

// `/signal` is gated more tightly than posting is, and the gap is the whole point: a
// supergroup member can post but must not be able to publish a call through us. A setup that
// passes every other check can still ignore every command typed into it.
describe('signalRights', () => {
  it('passes an admin of a broadcast channel who can also tidy up after themselves', () => {
    const entity = channel({
      broadcast: true,
      adminRights: new Api.ChatAdminRights({ postMessages: true, deleteMessages: true }),
    });
    expect(signalRights(entity).status).toBe('ok');
  });

  it('passes the creator, who needs no rights spelled out', () => {
    expect(signalRights(channel({ broadcast: true, creator: true })).status).toBe('ok');
  });

  // Publishing still works; the typed command just stays sitting above the card.
  it('warns when the command cannot be deleted afterwards', () => {
    const entity = channel({ broadcast: true, adminRights: new Api.ChatAdminRights({ postMessages: true }) });
    const check = signalRights(entity);

    expect(check.status).toBe('warn');
    expect(check.hint).toContain('Delete Messages');
  });

  it('fails a broadcast channel this account does not administer', () => {
    expect(signalRights(channel({ broadcast: true })).status).toBe('fail');
  });

  // The case postRights cannot catch: posting is open to everyone here, publishing is not.
  it('fails an ordinary member of a supergroup, who can post but must not publish', () => {
    expect(postRights(channel({ megagroup: true })).status).toBe('ok');
    expect(signalRights(channel({ megagroup: true })).status).toBe('fail');
  });

  it('passes an admin of a supergroup', () => {
    const entity = channel({ megagroup: true, adminRights: new Api.ChatAdminRights({}) });
    expect(signalRights(entity).status).toBe('ok');
  });

  it('fails a basic group this account does not administer', () => {
    expect(signalRights(chat({})).status).toBe('fail');
    expect(signalRights(chat({ creator: true })).status).toBe('ok');
  });
});

describe('reactionCheck', () => {
  const warRoom = channel({ megagroup: true });

  it('passes when all reactions are allowed', async () => {
    const check = await reactionCheck(fullChat(new Api.ChatReactionsAll({})), PEER, warRoom);
    expect(check.status).toBe('ok');
  });

  // Nothing logs when this is wrong: cards keep posting and no reaction can ever fire one.
  it('fails when reactions are switched off', async () => {
    const check = await reactionCheck(fullChat(new Api.ChatReactionsNone()), PEER, warRoom);
    expect(check.status).toBe('fail');
    expect(check.hint).toMatch(/Reactions/);
  });

  it('fails when no approving reaction is allowed', async () => {
    const some = new Api.ChatReactionsSome({ reactions: [new Api.ReactionEmoji({ emoticon: '❤' })] });
    expect((await reactionCheck(fullChat(some), PEER, warRoom)).status).toBe('fail');
  });

  it('warns, and names the substitute, when 🚀 is missing but another approval works', async () => {
    const some = new Api.ChatReactionsSome({
      reactions: [new Api.ReactionEmoji({ emoticon: '🔥' }), new Api.ReactionEmoji({ emoticon: '👎' })],
    });
    const check = await reactionCheck(fullChat(some), PEER, warRoom);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('🔥');
  });

  it('passes when 🚀 and 👎 are both allowed', async () => {
    const some = new Api.ChatReactionsSome({
      reactions: [new Api.ReactionEmoji({ emoticon: '🚀' }), new Api.ReactionEmoji({ emoticon: '👎' })],
    });
    expect((await reactionCheck(fullChat(some), PEER, warRoom)).status).toBe('ok');
  });

  it('warns rather than failing when the reaction settings cannot be read', async () => {
    const broken = {
      invoke: async () => {
        throw new Error('CHAT_ADMIN_REQUIRED (caused by channels.GetFullChannel)');
      },
    } as unknown as TelegramClient;
    const check = await reactionCheck(broken, PEER, warRoom);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('CHAT_ADMIN_REQUIRED');
    expect(check.detail).not.toContain('caused by');
  });
});

// Setting this up is four values in a file, and `loadConfig` throws on the first blank one.
// Reporting them one per run turns a five-minute job into four rounds of guesswork.
describe('credentialChecks', () => {
  const filled = { TG_API_ID: '1', TG_API_HASH: 'abc', TG_SESSION: 'sess' };

  it('says nothing once the account is set up', () => {
    expect(credentialChecks(filled)).toHaveLength(0);
  });

  it('names every missing value at once, not just the first', () => {
    const checks = credentialChecks({});
    expect(checks.map((c) => c.label)).toEqual(['TG_API_ID', 'TG_API_HASH', 'TG_SESSION']);
    // A missing value is useless without the one place it comes from.
    for (const check of checks) expect(check.hint).toBeTruthy();
  });

  it('treats a blank value as missing, since dotenv reads one as an empty string', () => {
    expect(credentialChecks({ ...filled, TG_SESSION: '   ' }).map((c) => c.label)).toEqual(['TG_SESSION']);
  });

  // The session is the one value not sitting on a web page, and the only one whose hint can
  // send somebody somewhere worse: `npm run login` prints a full account credential to a
  // terminal, where it gets scrolled past and screenshotted. Setup writes it to .env instead.
  it('points at npm run setup for the session rather than anything that prints it', () => {
    const hint = credentialChecks({ ...filled, TG_SESSION: '' })[0]!.hint;
    expect(hint).toContain('npm run setup');
    expect(hint).not.toContain('npm run login');
  });
});
