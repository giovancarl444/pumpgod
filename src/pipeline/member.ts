import type { AppConfig, CompetitionConfig } from '../config';
import { escapeHtml, money } from '../format/call';
import { log } from '../log';
import { journal } from '../store/journal';
import { Members, type MemberRecord } from '../store/members';
import { byCaller, rank, type CallerRecord } from '../track/stats';
import type { Tracker } from '../track/tracker';
import type { DirectMessage } from '../telegram/botingest';
import type { ParsedCall, Signal } from '../types';
import { resolveManualCall } from './manual';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One record per member, in the same tracker as everything else.
 *
 * The same tracker, deliberately. A second instance would double the price API volume and —
 * worse — produce two different peaks for the same token, so a member's card and the pinned
 * board could disagree in public about a number both claim to have measured. `poll()` already
 * batches by coin, so a member picking something we called ourselves costs nothing at all.
 */
export const MEMBER_PREFIX = 'member:';

export function memberSourceId(userId: string): string {
  return `${MEMBER_PREFIX}${userId}`;
}

export function memberIdFrom(sourceId: string): string | undefined {
  return sourceId.startsWith(MEMBER_PREFIX) ? sourceId.slice(MEMBER_PREFIX.length) : undefined;
}

/** A member's standing: their tracker record, plus the name to put next to it. */
export interface Standing extends CallerRecord {
  memberId: string;
  handle?: string;
}

export interface MemberHandlers {
  /**
   * Answers in text rather than sending it. The DM router owns the socket, which keeps this
   * module a function from a message to a reply — the part worth having tests for.
   */
  submit(dm: DirectMessage, argument?: string): Promise<string>;
  leaderboard(): Standing[];
  standingFor(userId: string): Standing | undefined;
  members: Members;
}

export interface MemberDeps {
  config: AppConfig;
  competition: CompetitionConfig;
  tracker: Tracker;
  members?: Members;
}

/**
 * The call competition: members pick, we price, the table sorts itself.
 *
 * Submissions are **DM-only**, and that is not a UX preference. A pick posted in the channel is
 * an unvetted call sitting in our feed with our name above it; by the time anyone corrects it,
 * somebody has bought. Here it is measured in private and only ever surfaces as a number on a
 * leaderboard, next to the name of whoever chose it.
 */
export function createMemberHandlers(deps: MemberDeps): MemberHandlers {
  const { config, competition, tracker } = deps;
  const members = deps.members ?? new Members();

  const submit = async (dm: DirectMessage, argument?: string): Promise<string> => {
    if (!competition.enabled) return 'The call competition is not running at the moment.';

    const text = (argument ?? dm.text).trim();
    if (!text) return 'Send <code>/submit &lt;contract address&gt;</code> to enter a pick.';

    // The cheap gate first, so somebody out of picks is not made to wait on a market lookup
    // to be told what we already knew.
    const now = Date.now();
    const used = members.pickedSince(dm.fromId, now, DAY_MS);
    if (used >= competition.picksPerDay) {
      const next = members.nextPickAt(dm.fromId, now, DAY_MS, competition.picksPerDay);
      return (
        `You have used ${used === 1 ? 'your pick' : `all ${used} of your picks`} for today. ` +
        (next ? `Next one in ${until(next - now)}.` : 'Try again tomorrow.')
      );
    }

    const outcome = await resolveManualCall(text, Math.max(config.enrichTimeoutMs, 5000), config.chains);
    if (!outcome.ok) return `✗ ${escapeHtml(outcome.reason)}`;

    const { token } = outcome.call;
    const sourceId = memberSourceId(dm.fromId);

    // Re-submitting the same coin would be merged by the tracker into the existing record and
    // silently cost them a pick for nothing. Better to say so and let them spend it elsewhere.
    const already = tracker
      .list()
      .find((c) => c.sourceId === sourceId && sameCoin(c.chain, c.address, token.chain, token.address));
    if (already) {
      return `You already have ${escapeHtml(labelOf(outcome.call))} in the competition — pick something else.`;
    }

    const member = members.upsert(dm.fromId, usernameOf(dm.handle));
    tracker.track(memberSignal(member, outcome.call), 'member');
    members.notePick(member, now);
    journal.write('member-pick', { member: member.id, chain: token.chain, address: token.address });
    log.info(`🎯 ${member.handle ?? member.id} picked ${labelOf(outcome.call)}`);

    // The entry is quoted back because it is the number the whole score is measured against,
    // and because a person who can see it can check the multiple themselves later.
    const entry = money(outcome.call.stats.marketCapUsd);
    return [
      `✅ <b>${escapeHtml(labelOf(outcome.call))}</b> is in${entry ? ` at ${entry}` : ''}.`,
      '',
      'It is priced every minute for 24 hours and scored on its peak. ' +
        'Nothing you submit is posted in the channel — only the result reaches the leaderboard.',
      '',
      'See where you stand with /me, or the table with /leaderboard.',
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  };

  /** Everybody with at least one pick, best first, under-sampled members at the bottom. */
  const leaderboard = (): Standing[] => {
    const picks = tracker.list().filter((c) => c.outcome === 'member');
    const standings = byCaller(picks).flatMap((record): Standing[] => {
      const memberId = memberIdFrom(record.id);
      if (!memberId) return [];
      return [{ ...record, memberId, handle: members.find(memberId)?.handle }];
    });
    return rank(standings, competition.minSample);
  };

  const standingFor = (userId: string): Standing | undefined =>
    leaderboard().find((s) => s.memberId === userId);

  return { submit, leaderboard, standingFor, members };
}

/**
 * `handleOf` gives us `@username` when there is one and Telegram's `first_name` when there is
 * not. Only the first is kept: a first name is chosen by the member, is not unique, and would
 * be printed on a public table that decides who is winning. Two people called "alex" on a
 * leaderboard is a dispute; one of them called `<b>alex</b>` is an injection.
 */
function usernameOf(handle: string | undefined): string | undefined {
  return handle?.startsWith('@') ? handle : undefined;
}

function sameCoin(chainA: string, addressA: string, chainB: string, addressB: string): boolean {
  return chainA === chainB && addressA.toLowerCase() === addressB.toLowerCase();
}

function labelOf(call: ParsedCall): string {
  return call.ticker ? `$${call.ticker}` : `${call.token.address.slice(0, 6)}…`;
}

function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * The tracker takes a `Signal`, so a member's pick has to look like one to be measured at all.
 *
 * The `member:<id>` source id is what keeps it in its own record: a coin a member picked and we
 * also called ends up as two rows with two entry prices, which is the only way to tell whether
 * they were early to it or we were. And `isPublished` asks for `called`, which this can never
 * become — see the note on `RANK` in the tracker.
 */
function memberSignal(member: MemberRecord, call: ParsedCall): Signal {
  return {
    id: `member-${member.id}-${Date.now()}`,
    source: {
      id: memberSourceId(member.id),
      label: member.handle ?? `member ${member.id}`,
      mode: 'shadow',
      enabled: true,
    },
    chatId: member.id,
    messageId: 0,
    rawText: '',
    call,
    confirmations: [],
    ageSec: 0,
    stale: false,
    risk: { level: 'clear', flags: [] },
    timings: { messageUnix: Math.floor(Date.now() / 1000), recvAt: performance.now(), wallClockMs: Date.now() },
  };
}
