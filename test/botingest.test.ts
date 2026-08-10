import { describe, expect, it } from 'vitest';
import type { BotApi } from '../src/telegram/botapi';
import { BotAdmins, startBotIngest } from '../src/telegram/botingest';
import type { ControlChats, IncomingCommand, IncomingReaction } from '../src/telegram/ingest';

/**
 * A bot receives everything through one long poll, so this file is about what we do with what
 * comes back: which chats we listen to, which we ignore, and — the one that would be silently
 * wrong in production — that a `/signal` typed while the bot was down is never acted on.
 */

const WAR_ROOM = '-1009999999999';
const CHANNEL = '-1001234567890';
const CONTROL: ControlChats = { warRoomId: WAR_ROOM, channelId: CHANNEL };

interface Update {
  update_id: number;
  message?: unknown;
  channel_post?: unknown;
  message_reaction?: unknown;
}

function text(update_id: number, chatId: string, body: string, fromId = 42): Update {
  return {
    update_id,
    message: { message_id: update_id, chat: { id: Number(chatId), type: 'supergroup' }, from: { id: fromId }, text: body },
  };
}

/**
 * Serves `getUpdates` in the order the loop asks: the boot backlog sweep first, then one live
 * batch, then nothing. The third call stops the loop, so the poll never outlives the test.
 */
function poll(batch: Update[], control: ControlChats = CONTROL, backlog: Update[] = []) {
  const commands: IncomingCommand[] = [];
  const reactions: IncomingReaction[] = [];
  const asked: Array<Record<string, unknown>> = [];
  let handle: { stop(): void } | undefined;
  let served = 0;
  let finish!: () => void;
  const idle = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const api = {
    async call(_method: string, params: Record<string, unknown>) {
      asked.push(params);
      served += 1;
      if (served === 1) return backlog;
      if (served === 2) return batch;
      handle?.stop();
      finish();
      return [];
    },
  } as unknown as BotApi;

  handle = startBotIngest(api, control, {
    onCommand: (cmd) => commands.push(cmd),
    onReaction: (reaction) => reactions.push(reaction),
  });

  return { commands, reactions, asked, idle };
}

describe('coming back up', () => {
  // A `/signal` typed while the bot was down is for a coin that moved hours ago. Publishing it
  // now would put an entry price on the card that nobody could have got — a worse failure than
  // missing the call, because it is a lie the tracker then measures against.
  it('never acts on a command typed while it was down', async () => {
    const missed = text(100, WAR_ROOM, '/signal So11111111111111111111111111111111111111112');
    const run = poll([], CONTROL, [missed]);
    await run.idle;

    expect(run.commands).toHaveLength(0);
    expect(run.asked[0]).toMatchObject({ offset: -1, timeout: 0 });
  });

  // Telegram redelivers anything not confirmed. Resuming from the backlog's last update_id is
  // what makes the discard stick — start from 0 and the stale call arrives on the next poll.
  it('resumes past the backlog it just threw away', async () => {
    const run = poll([], CONTROL, [text(100, WAR_ROOM, 'hello'), text(101, WAR_ROOM, 'hello')]);
    await run.idle;

    expect(run.asked[1]).toMatchObject({ offset: 102 });
  });

  it('asks for reactions by name', async () => {
    // Telegram sends no reaction updates at all unless they are listed, and the 🚀 approval in
    // the war room is the only way a screened call ever gets published.
    const run = poll([]);
    await run.idle;

    expect(run.asked[1]!.allowed_updates).toContain('message_reaction');
  });
});

describe('what counts as a command', () => {
  it('takes one typed in the war room', async () => {
    const run = poll([text(1, WAR_ROOM, '/signal abc')]);
    await run.idle;

    expect(run.commands).toHaveLength(1);
    expect(run.commands[0]).toMatchObject({ text: '/signal abc', chatId: WAR_ROOM, fromId: '42', post: false, fromChannel: false });
  });

  it('marks a channel post as one, and as coming from the channel', async () => {
    // Both flags are read downstream: `post` is the admin proof, `fromChannel` is what makes the
    // command message get cleaned up afterwards so the channel stays a feed of calls.
    const run = poll([
      { update_id: 2, channel_post: { message_id: 7, chat: { id: Number(CHANNEL), type: 'channel' }, text: '/signal abc' } },
    ]);
    await run.idle;

    expect(run.commands[0]).toMatchObject({ post: true, fromChannel: true, messageId: 7, fromId: undefined });
  });

  it('reads a caption, so a command sent with a picture still lands', async () => {
    const run = poll([
      {
        update_id: 3,
        message: { message_id: 3, chat: { id: Number(WAR_ROOM), type: 'supergroup' }, from: { id: 42 }, caption: '/signal abc' },
      },
    ]);
    await run.idle;

    expect(run.commands[0]).toMatchObject({ text: '/signal abc' });
  });

  it('ignores a chat that is neither the channel nor the war room', async () => {
    // A bot can be added to any group by that group's admin. Anything it hears there is a
    // stranger talking, and a stranger must not be able to make us publish.
    const run = poll([text(4, '-1005555555555', '/signal abc')]);
    await run.idle;

    expect(run.commands).toHaveLength(0);
  });
});

describe('reactions', () => {
  const rocket = (chatId: string) => ({
    update_id: 5,
    message_reaction: {
      chat: { id: Number(chatId) },
      message_id: 11,
      user: { id: 42 },
      new_reaction: [{ type: 'emoji', emoji: '🚀' }],
    },
  });

  it('counts one in the war room', async () => {
    const run = poll([rocket(WAR_ROOM)]);
    await run.idle;

    expect(run.reactions[0]).toMatchObject({ chatId: WAR_ROOM, messageId: 11, emoji: '🚀', reactorId: '42' });
  });

  // Approval happens in the private war room. Honouring one in the public channel would let
  // any member who can react publish a call.
  it('ignores one in the channel', async () => {
    const run = poll([rocket(CHANNEL)]);
    await run.idle;

    expect(run.reactions).toHaveLength(0);
  });

  it('ignores a custom emoji, which carries no emoji to match on', async () => {
    const run = poll([
      {
        update_id: 6,
        message_reaction: {
          chat: { id: Number(WAR_ROOM) },
          message_id: 11,
          new_reaction: [{ type: 'custom_emoji' }],
        },
      },
    ]);
    await run.idle;

    expect(run.reactions).toHaveLength(0);
  });
});

describe('who may publish through us', () => {
  function admins(status: string | Error) {
    let lookups = 0;
    const api = {
      async call() {
        lookups += 1;
        if (status instanceof Error) throw status;
        return { status };
      },
    } as unknown as BotApi;
    return { admins: new BotAdmins(api, CHANNEL), lookups: () => lookups };
  }

  const cmd = (over: Partial<IncomingCommand> = {}): IncomingCommand => ({
    text: '/signal abc',
    chatId: WAR_ROOM,
    messageId: 1,
    fromId: '42',
    post: false,
    fromChannel: false,
    recvAt: 0,
    ...over,
  });

  it('lets an admin through and turns a member away', async () => {
    await expect(admins('administrator').admins.allows(cmd())).resolves.toBe(true);
    await expect(admins('creator').admins.allows(cmd())).resolves.toBe(true);
    await expect(admins('member').admins.allows(cmd())).resolves.toBe(false);
  });

  // A channel post is proof in itself — Telegram only lets admins post to a broadcast channel —
  // and asking anyway would put a round trip in front of every call we make from the channel.
  it('asks nobody about a channel post', async () => {
    const { admins: a, lookups } = admins('member');
    await expect(a.allows(cmd({ post: true, fromChannel: true }))).resolves.toBe(true);
    expect(lookups()).toBe(0);
  });

  it('remembers the answer, so the check costs one round trip per person', async () => {
    const { admins: a, lookups } = admins('administrator');
    await a.allows(cmd());
    await a.allows(cmd({ messageId: 2 }));
    expect(lookups()).toBe(1);
  });

  // Telegram being unreachable must not become a way to publish. Denying is the only safe
  // reading of "we could not tell".
  it('denies when the lookup fails', async () => {
    const { admins: a } = admins(new Error('Bad Request: user not found'));
    await expect(a.allows(cmd())).resolves.toBe(false);
  });
});

/**
 * The long poll and Node's own HTTP client each have a deadline, and only one of them is
 * visible in this file. Telegram sends nothing at all while it waits, so if the poll is
 * allowed to run as long as `fetch` will wait for headers, the two expire together and
 * whichever wins is decided by network latency — which in production meant fetch, every
 * quiet half-minute, forever.
 */
describe('the long poll deadline', () => {
  it('expires before fetch gives up on the response', async () => {
    const run = poll([]);
    await run.idle;

    // undici's headersTimeout, which the fetch API gives no way to raise.
    const FETCH_HEADERS_TIMEOUT_SEC = 30;
    const asked = run.asked[1]!.timeout as number;

    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(FETCH_HEADERS_TIMEOUT_SEC);
  });
});
