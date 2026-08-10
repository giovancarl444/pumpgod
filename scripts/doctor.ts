import { Api, TelegramClient } from 'telegram';
import { loadConfig, loadSources, type AppConfig } from '../src/config';
import { createClient, primeEntityCache, resolveInputPeer } from '../src/telegram/client';
import { FIRE, SKIP } from '../src/pipeline/router';
import { resolveManualCall } from '../src/pipeline/manual';
import { fetchImage } from '../src/telegram/photo';
import type { Source } from '../src/types';

/**
 * Proves the chain a call depends on, before a call depends on it.
 *
 * Every check here exists because the failure it catches is otherwise silent. A group this
 * account was kicked from still resolves happily out of the entity cache; a channel we cannot
 * post in only says so on the first real call; reactions disabled in the war room leave review
 * mode unable to approve anything. In all three cases the process starts up looking healthy and
 * the discovery costs a real call.
 *
 * Nothing here writes to Telegram. A test message flashed into the public channel to prove post
 * rights is visible to members even if it is deleted a moment later, so post rights are derived
 * from the entity instead. The `/signal` path is proven the same way: rights come off the
 * channel entity, and the market and image hops are exercised against a coin listed for years,
 * so a failure is our network rather than anything published.
 */

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  status: Status;
  label: string;
  detail: string;
  /** Shown under a ⚠/✗ line. One line, and it must say what to actually do. */
  hint?: string;
}

const SECTIONS = ['Account', 'Sources', 'Destinations', 'Calling', 'Behaviour'] as const;
type Section = (typeof SECTIONS)[number];

const ICON: Record<Status, string> = { ok: '✓', warn: '⚠', fail: '✗' };
const WIDTH = 74;
const LABEL_W = 22;

/** A source that has not posted in a week is probably dead, or we are reading the wrong group. */
const DEAD_SOURCE_SEC = 7 * 24 * 3600;

class Report {
  private readonly checks: (Check & { section: Section })[] = [];

  add(section: Section, check: Check): Check {
    this.checks.push({ section, ...check });
    return check;
  }

  count(status: Status): number {
    return this.checks.filter((c) => c.status === status).length;
  }

  render(): void {
    console.log(`\n  pumpgod doctor · nothing is sent, nothing is written\n`);

    for (const section of SECTIONS) {
      const rows = this.checks.filter((c) => c.section === section);
      if (!rows.length) continue;

      console.log(`  ${section}`);
      console.log(`  ${'─'.repeat(WIDTH)}`);
      for (const row of rows) {
        const label = row.label.length < LABEL_W ? row.label.padEnd(LABEL_W) : `${row.label} `;
        console.log(`  ${ICON[row.status]}  ${label}${row.detail}`);
        if (row.hint) console.log(`     ${' '.repeat(LABEL_W)}└ ${row.hint}`);
      }
      console.log('');
    }

    const failed = this.count('fail');
    const warned = this.count('warn');
    console.log(`  ${'═'.repeat(WIDTH)}`);
    if (failed) {
      console.log(
        `  ✗  ${plural(failed, 'blocking problem')}${warned ? `, ${plural(warned, 'warning')}` : ''} — ` +
          `pumpgod would start up looking healthy and lose calls.`,
      );
    } else if (warned) {
      console.log(`  ⚠  clear to run, with ${plural(warned, 'warning')} above.`);
    } else {
      console.log('  ✓  the whole chain checks out. Safe to run `npm run dev`.');
    }
    console.log('');
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** GramJS wraps the RPC error code in prose; the code is the part worth showing. */
function reason(err: unknown): string {
  const e = err as { errorMessage?: string; message?: string };
  return (e.errorMessage ?? e.message ?? String(err)).replace(/\s*\(caused by .*\)$/, '');
}

function ago(unixSec: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - unixSec));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

function titleOf(entity: Api.TypeChat | Api.TypeUser): string {
  const named = entity as { title?: string; username?: string; firstName?: string };
  return named.title ?? (named.username ? `@${named.username}` : named.firstName ?? 'unnamed');
}

/** Membership failures all present as an RPC code, and each has a different fix. */
function membershipHint(code: string): string {
  if (code.startsWith('CHANNEL_PRIVATE')) {
    return 'this account is not a member any more (kicked, or the group went private) — rejoin it, then re-run';
  }
  if (code.startsWith('CHAT_FORBIDDEN') || code.startsWith('USER_BANNED_IN_CHANNEL')) {
    return 'this account is banned here — it cannot be fixed from this side, use another account or drop the source';
  }
  if (code.startsWith('CHANNEL_INVALID') || code.startsWith('PEER_ID_INVALID')) {
    return 'the id/username in config/sources.json does not point at anything — re-copy it from `npm run dialogs`';
  }
  if (code.startsWith('AUTH_KEY') || code.startsWith('SESSION')) return 'the session is broken — run `npm run login` again';
  return 'this account cannot read that group — check it is still joined from the logged-in account';
}

/**
 * Whether we could post here, read off the entity alone. `adminRights` and `bannedRights` on a
 * Channel are this account's own rights in it, which is exactly the question being asked.
 */
export function postRights(entity: Api.TypeChat | Api.TypeUser): Omit<Check, 'label'> {
  if (entity instanceof Api.ChannelForbidden || entity instanceof Api.ChatForbidden) {
    return {
      status: 'fail',
      detail: 'this account is banned or removed from it',
      hint: 'rejoin from the logged-in account, or point this at a chat it is actually in',
    };
  }

  if (entity instanceof Api.ChatEmpty) {
    return { status: 'fail', detail: 'no such group', hint: 're-copy the id from `npm run dialogs`' };
  }

  if (entity instanceof Api.Channel) {
    const kind = entity.broadcast ? 'broadcast channel' : 'supergroup';

    if (entity.left) {
      return {
        status: 'fail',
        detail: `${kind} · this account has left it`,
        hint: 'rejoin it from the logged-in account, then re-run',
      };
    }
    if (entity.bannedRights?.sendMessages || entity.bannedRights?.sendPlain) {
      return {
        status: 'fail',
        detail: `${kind} · this account is restricted from posting`,
        hint: 'an admin has muted this account here — have the restriction lifted',
      };
    }

    if (entity.broadcast) {
      if (entity.creator) return { status: 'ok', detail: `${kind} · creator, can post` };
      if (entity.adminRights?.postMessages) return { status: 'ok', detail: `${kind} · admin with post rights` };
      return {
        status: 'fail',
        detail: `${kind} · not an admin, and only admins can post here`,
        hint: 'promote this account to admin on the channel and tick "Post Messages"',
      };
    }

    if (entity.creator || entity.adminRights) return { status: 'ok', detail: `${kind} · admin, can post` };
    if (entity.defaultBannedRights?.sendMessages || entity.defaultBannedRights?.sendPlain) {
      return {
        status: 'fail',
        detail: `${kind} · members cannot send messages`,
        hint: 'unmute members in the group permissions, or make this account an admin',
      };
    }
    return { status: 'ok', detail: `${kind} · member, can post` };
  }

  if (entity instanceof Api.Chat) {
    if (entity.left) {
      return { status: 'fail', detail: 'group · this account has left it', hint: 'rejoin it, then re-run' };
    }
    if (entity.deactivated || entity.migratedTo) {
      return {
        status: 'fail',
        detail: 'group · deactivated, it was upgraded to a supergroup',
        hint: 'the old id is dead — re-copy the new one from `npm run dialogs`',
      };
    }
    if (entity.creator || entity.adminRights) return { status: 'ok', detail: 'group · admin, can post' };
    if (entity.defaultBannedRights?.sendMessages || entity.defaultBannedRights?.sendPlain) {
      return {
        status: 'fail',
        detail: 'group · members cannot send messages',
        hint: 'unmute members in the group permissions, or make this account an admin',
      };
    }
    return { status: 'ok', detail: 'group · member, can post' };
  }

  return {
    status: 'warn',
    detail: 'resolves to a private chat with a user, not a channel or group',
    hint: 'almost certainly the wrong id — check it against `npm run dialogs`',
  };
}

/**
 * Whether `/signal` typed in the channel would be honoured, and whether the command message
 * can then be cleaned up.
 *
 * The two chat kinds answer this differently. A broadcast channel only lets admins post, so
 * the message existing is the proof and post rights are the whole story. A supergroup lets
 * anyone type, so the command is gated on admin rights that `postRights` does not require —
 * meaning a setup that passes every other check here can still ignore every command.
 */
export function signalRights(entity: Api.TypeChat | Api.TypeUser): Omit<Check, 'label'> {
  const admin = (e: Api.Channel | Api.Chat) => Boolean(e.creator || e.adminRights);

  if (entity instanceof Api.Channel) {
    if (entity.broadcast) {
      if (!admin(entity)) {
        return {
          status: 'fail',
          detail: 'broadcast channel · not an admin, so nothing typed here can publish',
          hint: 'promote this account to admin on the channel and tick "Post Messages"',
        };
      }
      // Deleting your own post needs the right explicitly, unless you created the channel.
      if (!entity.creator && !entity.adminRights?.deleteMessages) {
        return {
          status: 'warn',
          detail: 'broadcast channel · admin, but cannot delete messages',
          hint: 'tick "Delete Messages" too, or the typed /signal stays visible above the card',
        };
      }
      return { status: 'ok', detail: 'broadcast channel · admin, /signal will publish' };
    }

    if (!admin(entity)) {
      return {
        status: 'fail',
        detail: 'supergroup · not an admin, so /signal will be ignored here',
        hint: 'promote this account to admin — in a supergroup anyone can type, so we check',
      };
    }
    return { status: 'ok', detail: 'supergroup · admin, /signal will publish' };
  }

  if (entity instanceof Api.Chat) {
    return admin(entity)
      ? { status: 'ok', detail: 'group · admin, /signal will publish' }
      : {
          status: 'fail',
          detail: 'group · not an admin, so /signal will be ignored here',
          hint: 'promote this account to admin in the group',
        };
  }

  return { status: 'warn', detail: 'not a channel or group, so /signal has no admin to check' };
}

/**
 * The half of `/signal` that has nothing to do with Telegram: turning an address into live
 * numbers, then fetching the artwork the card is posted as. Both are third-party calls, and
 * both fail in ways that look from the outside like the bot ignoring you.
 *
 * Probed with a coin that has been listed for years, so a failure here is our network or
 * DexScreener — never the coin.
 */
async function callPathChecks(config: AppConfig): Promise<Check[]> {
  const PROBE = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const checks: Check[] = [];

  checks.push({
    status: 'ok',
    label: 'chains',
    detail: config.chains.length ? `calling ${config.chains.join(', ')} only` : 'calling every chain',
    hint: config.chains.length ? undefined : 'CHAINS=all is set — nothing is filtered by chain',
  });

  const started = Date.now();
  // No chain restriction on the probe itself: this is asking whether DexScreener answers, and
  // reporting "wrong chain" for a coin we picked ourselves would be a confusing way to say so.
  const outcome = await resolveManualCall(PROBE, 5000);
  const ms = Date.now() - started;

  if (!outcome.ok) {
    checks.push({
      status: 'fail',
      label: 'market data',
      detail: `DexScreener could not price a known coin: ${outcome.reason}`,
      hint: 'no market data means /signal refuses every address — check the network, then retry',
    });
    return checks;
  }

  checks.push({ status: 'ok', label: 'market data', detail: `DexScreener answered in ${ms}ms` });

  if (!config.showImage) {
    checks.push({
      status: 'warn',
      label: 'coin artwork',
      detail: 'SHOW_IMAGE=false — cards are posted as text',
      hint: 'set SHOW_IMAGE=true in .env to post the coin image with the call',
    });
    return checks;
  }

  const url = outcome.call.imageUrl;
  if (!url) {
    checks.push({ status: 'warn', label: 'coin artwork', detail: 'the probe coin has no indexed image' });
    return checks;
  }

  const imgStarted = Date.now();
  const image = await fetchImage(url, 5000);
  checks.push(
    image
      ? {
          status: 'ok',
          label: 'coin artwork',
          detail: `fetched ${(image.bytes.length / 1024).toFixed(0)}KB in ${Date.now() - imgStarted}ms`,
        }
      : {
          status: 'warn',
          label: 'coin artwork',
          detail: 'the image CDN did not serve a known coin logo',
          hint: 'calls still publish, as text — the picture is the only thing lost',
        },
  );
  return checks;
}

/**
 * Review mode is a reaction, so the war room's reaction settings decide whether approval is
 * physically possible. Disabled reactions make every staged call unapprovable, silently.
 */
export async function reactionCheck(
  client: TelegramClient,
  peer: Api.TypeInputPeer,
  entity: Api.TypeChat | Api.TypeUser,
): Promise<Check> {
  const label = 'approve reactions';

  let available: Api.TypeChatReactions | undefined;
  try {
    const full =
      entity instanceof Api.Chat
        ? await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }))
        : await client.invoke(new Api.channels.GetFullChannel({ channel: peer }));
    available = (full.fullChat as { availableReactions?: Api.TypeChatReactions }).availableReactions;
  } catch (err) {
    return {
      status: 'warn',
      label,
      detail: `could not read the war room's reaction settings: ${reason(err)}`,
      hint: 'check by hand that 🚀 can be used in the war room, or review mode may be unable to approve',
    };
  }

  if (available instanceof Api.ChatReactionsNone) {
    return {
      status: 'fail',
      label,
      detail: 'reactions are disabled in the war room — nothing can ever be approved',
      hint: 'Telegram → war room → Manage → Reactions → enable them, 🚀 and 👎 at minimum',
    };
  }

  if (available instanceof Api.ChatReactionsSome) {
    const allowed = new Set(
      available.reactions
        .filter((r): r is Api.ReactionEmoji => r instanceof Api.ReactionEmoji)
        .map((r) => r.emoticon),
    );
    const canFire = [...FIRE].filter((e) => allowed.has(e));
    const canSkip = [...SKIP].filter((e) => allowed.has(e));

    if (!canFire.length) {
      return {
        status: 'fail',
        label,
        detail: `none of the approve reactions (${[...FIRE].join(' ')}) are enabled in the war room`,
        hint: 'Telegram → war room → Manage → Reactions → add 🚀',
      };
    }

    const missing = [!allowed.has('🚀') && '🚀 approve', !allowed.has('👎') && '👎 skip'].filter(
      (m): m is string => Boolean(m),
    );
    if (missing.length) {
      return {
        status: 'warn',
        label,
        detail: `${missing.join(' and ')} not enabled · approve with ${canFire.join(' ')}${
          canSkip.length ? `, skip with ${canSkip.join(' ')}` : ''
        }`,
        hint: 'add 🚀 and 👎 in the war room reaction settings so the documented taps work',
      };
    }
  }

  return { status: 'ok', label, detail: 'ready · 🚀 approves, 👎 skips' };
}

/** Resolution succeeds from cache even for a group we were kicked from. Reading one message cannot. */
async function checkSource(client: TelegramClient, source: Source): Promise<Check> {
  const label = `${source.id} [${source.mode}]`;
  const target = source.peerId ?? source.username!;

  let peer: Api.TypeInputPeer;
  try {
    peer = await resolveInputPeer(client, target);
  } catch (err) {
    const code = reason(err);
    return { status: 'fail', label, detail: `will not resolve: ${code}`, hint: membershipHint(code) };
  }

  try {
    const messages = await client.getMessages(peer, { limit: 1 });
    const last = messages[0];
    if (!last) {
      return {
        status: 'warn',
        label,
        detail: 'readable, but it has no messages to read',
        hint: 'an empty group, or history hidden from new members — new posts should still arrive',
      };
    }

    const age = Math.max(0, Math.round(Date.now() / 1000 - last.date));
    if (age > DEAD_SOURCE_SEC) {
      return {
        status: 'warn',
        label,
        detail: `readable · last post ${ago(last.date)}`,
        hint: 'nothing posted in over a week — dead group, or the id points at the wrong one',
      };
    }
    return { status: 'ok', label, detail: `readable · last post ${ago(last.date)}` };
  } catch (err) {
    const code = reason(err);
    return { status: 'fail', label, detail: `resolves, but reading it failed: ${code}`, hint: membershipHint(code) };
  }
}

async function main(): Promise<number> {
  const report = new Report();

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    report.add('Account', {
      status: 'fail',
      label: 'env',
      detail: reason(err),
      hint: 'the API id and hash come from https://my.telegram.org → API development tools',
    });
    report.render();
    return 1;
  }

  if (!config.session) {
    report.add('Account', {
      status: 'fail',
      label: 'session',
      detail: 'TG_SESSION is empty',
      hint: 'run `npm run login`, then paste the session string into .env',
    });
    report.render();
    return 1;
  }

  let sources: Source[] = [];
  let sourcesError: string | undefined;
  try {
    sources = loadSources().filter((s) => s.enabled);
  } catch (err) {
    sourcesError = reason(err);
  }

  const client = createClient(config);
  await client.connect();

  try {
    if (!(await client.checkAuthorization())) {
      report.add('Account', {
        status: 'fail',
        label: 'session',
        detail: 'TG_SESSION is no longer authorised',
        hint: 'the session was revoked or expired — run `npm run login` again',
      });
      report.render();
      return 1;
    }

    const me = (await client.getMe()) as { username?: string; id?: { toString(): string } };
    report.add('Account', {
      status: 'ok',
      label: 'session',
      detail: `authorised as ${me.username ? `@${me.username}` : 'an account with no username'} · id ${me.id?.toString() ?? '?'}`,
    });

    // Same priming the engine does at boot, so resolution below behaves identically.
    await primeEntityCache(client);

    if (sourcesError) {
      report.add('Sources', {
        status: 'fail',
        label: 'config',
        detail: sourcesError,
        hint: 'copy config/sources.example.json to config/sources.json and list the groups to track',
      });
    } else if (!sources.length) {
      report.add('Sources', {
        status: 'fail',
        label: 'config',
        detail: 'no enabled sources',
        hint: 'set "enabled": true on at least one entry in config/sources.json',
      });
    } else {
      // Sequential on purpose: a flood wait triggered by hammering resolution would be
      // reported as a broken source, which is exactly the wrong diagnosis.
      for (const source of sources) report.add('Sources', await checkSource(client, source));
    }

    // Only set once the war room is proven postable — running the reaction check against a
    // chat we have already established we cannot post in reports a second, confusing failure.
    let warRoom: { peer: Api.TypeInputPeer; entity: Api.TypeChat | Api.TypeUser } | undefined;
    // Held so the `/signal` check can read admin rights off it rather than resolving twice.
    let channelEntity: Api.TypeChat | Api.TypeUser | undefined;

    for (const [label, target] of [
      ['channel', config.channel],
      ['war room', config.warRoom],
    ] as const) {
      if (!target) {
        if (label === 'channel') {
          report.add('Destinations', {
            status: 'fail',
            label: 'channel',
            detail: 'PUMPGOD_CHANNEL is not set — there is nowhere to publish',
            hint: 'put the public channel id (-100…) or @username in .env',
          });
        } else {
          report.add('Destinations', {
            status: 'warn',
            label: 'war room',
            detail: 'WAR_ROOM_CHAT is not set — there is nowhere to review',
            hint: 'without one, stale and high-risk calls are dropped instead of being offered to a human',
          });
        }
        continue;
      }

      try {
        const peer = await resolveInputPeer(client, target);
        const entity = (await client.getEntity(peer)) as Api.TypeChat | Api.TypeUser;
        const rights = postRights(entity);
        if (label === 'war room' && rights.status !== 'fail') warRoom = { peer, entity };
        if (label === 'channel') channelEntity = entity;
        report.add('Destinations', { ...rights, label, detail: `${titleOf(entity)} · ${rights.detail}` });
      } catch (err) {
        const code = reason(err);
        report.add('Destinations', {
          status: 'fail',
          label,
          detail: `"${target}" will not resolve: ${code}`,
          hint: membershipHint(code),
        });
      }
    }

    if (channelEntity) report.add('Calling', { ...signalRights(channelEntity), label: '/signal rights' });
    for (const check of await callPathChecks(config)) report.add('Calling', check);

    const needsReview = sources.filter((s) => s.mode === 'review');
    if (warRoom) {
      report.add('Behaviour', await reactionCheck(client, warRoom.peer, warRoom.entity));
    } else if (needsReview.length) {
      report.add('Behaviour', {
        status: 'fail',
        label: 'review mode',
        detail: `${plural(needsReview.length, 'source')} in review mode with no working war room`,
        hint: `their calls are parsed and then dropped — fix WAR_ROOM_CHAT, or move ${needsReview
          .map((s) => s.id)
          .join(', ')} to shadow`,
      });
    }

    report.add('Behaviour', {
      status: config.live ? 'ok' : 'warn',
      label: 'publishing',
      detail: config.live ? 'LIVE=true — approved calls are posted for real' : 'LIVE=false — nothing is ever published',
      hint: config.live ? undefined : 'calls are parsed, staged and logged only. Set LIVE=true in .env when ready',
    });

    report.render();
    return report.count('fail') ? 1 : 0;
  } finally {
    await client.disconnect();
  }
}

// Guarded so the checks above can be imported and tested without opening a socket.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`\n  ✗  doctor could not finish: ${reason(err)}\n`);
      process.exit(1);
    });
}
