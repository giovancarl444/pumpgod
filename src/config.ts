import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { chainFromSlug } from './parse/chains';
import type { Chain, Source, SourceMode } from './types';

loadEnv();

const ROOT = resolve(__dirname, '..');
const SOURCES_PATH = resolve(ROOT, 'config/sources.json');

function required(key: string): string {
  const v = process.env[key]?.trim();
  if (!v) throw new Error(`Missing required env var ${key}. Copy .env.example to .env and fill it in.`);
  return v;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

/**
 * Which forum topic to publish into, as either the bare id or the link Telegram's own
 * "Copy Link" gives — `t.me/name/291` for a public group, `t.me/c/1234567890/291` for a
 * private one. Every spelling ends in the topic id, so the last run of digits is the answer.
 *
 * A wrong id here is worth refusing rather than defaulting, because Telegram treats an absent
 * thread as General and posts there quite happily — so the failure is a card in the wrong
 * place, which reads as the setting being ignored.
 */
function topic(key: string): number | undefined {
  const raw = process.env[key]?.trim();
  if (!raw) return undefined;

  const digits = raw.match(/\d+/g)?.pop();
  const id = Number(digits);
  if (!digits || !Number.isSafeInteger(id) || id <= 0) {
    throw new Error(`${key}="${raw}" is not a topic id. Paste the topic's link, or just its number.`);
  }
  return id;
}

/**
 * A typo here would silently widen what we are willing to call, which is the opposite of
 * what someone setting this is trying to do — so an unrecognised chain is an error, not a
 * skipped entry. `CHAINS=all` is the explicit way to say "no restriction".
 */
function chainList(key: string, fallback: Chain[]): Chain[] {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  if (raw.toLowerCase() === 'all') return [];

  return raw.split(',').map((part) => {
    const chain = chainFromSlug(part);
    if (!chain || chain === 'unknown') {
      throw new Error(`${key} lists an unknown chain "${part.trim()}". Use chain names like solana,base — or "all".`);
    }
    return chain;
  });
}

/**
 * Telegram clients show channel ids as -100xxxxxxxxxx but the wire protocol uses the
 * bare id. Everything internal keys off the bare form so both spellings work in config.
 */
export function normalisePeerId(raw: string | number): string {
  const s = String(raw).trim();
  const digits = s.replace(/^-100/, '').replace(/^-/, '');
  return digits;
}

/** How a call is judged and rendered. Needs no Telegram credentials, so `npm run call` can
 *  resolve and show a real call before the account is ever set up. */
export interface PresentationConfig {
  live: boolean;
  showSource: boolean;
  footer: string;
  enrichEnabled: boolean;
  enrichTimeoutMs: number;
  maxCallAgeSec: number;
  /** Chains we are willing to call at all. Empty means every chain. */
  chains: Chain[];
  /** Attach the coin's artwork to the public post. */
  showImage: boolean;
  /** Buy-button templates, `{address}` substituted. Blank falls back to a DexScreener search. */
  tradeUrlSol: string;
  tradeUrlEvm: string;
  /** Signup referral link and its call-to-action, rendered once per public call. */
  referralUrl?: string;
  referralLabel: string;
}

export interface AppConfig extends PresentationConfig {
  apiId: number;
  apiHash: string;
  session: string;
  /** From BotFather. Publishes without a phone number, and can never read a group it is not in. */
  botToken: string;
  channel: string;
  warRoom?: string;
  /** Forum topic to publish into. Unset means the group's General thread. */
  channelTopic?: number;
  warRoomTopic?: number;
  dedupeTtlMs: number;
  metricsIntervalMs: number;
  catchupIntervalMs: number;
  trackIntervalMs: number;
}

export function loadPresentation(): PresentationConfig {
  return {
    live: bool('LIVE', false),
    showSource: bool('SHOW_SOURCE', false),
    footer: process.env.FOOTER?.trim() ?? 'NFA · DYOR',
    enrichEnabled: bool('ENRICH_ENABLED', true),
    enrichTimeoutMs: num('ENRICH_TIMEOUT_MS', 2500),
    maxCallAgeSec: num('MAX_CALL_AGE_SEC', 90),
    chains: chainList('CHAINS', ['solana']),
    showImage: bool('SHOW_IMAGE', true),
    tradeUrlSol: process.env.TRADE_URL_SOL?.trim() || 'https://axiom.trade/t/{address}',
    tradeUrlEvm: process.env.TRADE_URL_EVM?.trim() ?? '',
    referralUrl: process.env.REFERRAL_URL?.trim() || undefined,
    referralLabel: process.env.REFERRAL_LABEL?.trim() || 'Trade these faster',
  };
}

/** Growth settings. Separate from AppConfig because the recap feed reads `data/tracked.json`
 *  and needs no Telegram session to decide what it would post. */
export interface SocialConfig {
  /** Public channel link. Without it a post is proof with nowhere to convert. */
  channelUrl?: string;
  minMultiple: number;
  dailyRecap: boolean;
  postIntervalMs: number;
}

/**
 * Selling a promotion slot in the channel.
 *
 * Off by default, and it has to be: switching it on changes what the channel is, and that is
 * a decision rather than a setting somebody inherits from a default.
 *
 * Kept out of `AppConfig` for the same reason `SocialConfig` is — it belongs to a surface that
 * happens to run in the same process, not to the business of calling coins.
 */
export interface PromoConfig {
  enabled: boolean;
  /**
   * The price, in Telegram Stars.
   *
   * Stars are the only currency a bot may charge in for something delivered inside Telegram,
   * and Telegram sets the rate. It has been roughly €0.02 a Star to buy, so ~1000 Stars is
   * the €20 mark — but the app stores take their cut of the purchase and the payout rate
   * moves, so check the current figure before trusting the conversion.
   */
  priceStars: number;
  /** Slots per rolling 24h. The number that decides whether this is a channel or a billboard. */
  dailyLimit: number;
}

export function loadPromo(): PromoConfig {
  return {
    enabled: bool('PROMO_ENABLED', false),
    priceStars: num('PROMO_PRICE_STARS', 1000),
    dailyLimit: num('PROMO_DAILY_LIMIT', 3),
  };
}

export function loadSocial(): SocialConfig {
  return {
    channelUrl: process.env.CHANNEL_URL?.trim() || undefined,
    minMultiple: num('X_MIN_MULTIPLE', 5),
    dailyRecap: bool('X_DAILY_RECAP', true),
    postIntervalMs: num('X_POST_INTERVAL_SEC', 300) * 1000,
  };
}

/**
 * A bot token and a user session are alternatives, not a pair: the bot publishes, and only a
 * user account can read a rival group. Requiring the my.telegram.org credentials up front would
 * make the cheap half of the setup wait on the expensive one.
 */
export function loadConfig(): AppConfig {
  const botToken = process.env.TG_BOT_TOKEN?.trim() ?? '';
  const session = process.env.TG_SESSION?.trim() ?? '';

  // Holding neither is the fresh-clone state, and it needs saying as a choice between the two.
  // Left to `required` below, the first value that happens to be missing is TG_API_ID, so the
  // one message anybody sees before setting anything up sends them to my.telegram.org for a
  // developer app and a code to their phone — the half the bot path exists to make optional.
  if (!botToken && !session) {
    throw new Error(
      'No Telegram credentials. Run `npm run setup` — a bot token publishes your calls in about a minute, ' +
        'and a user account additionally reads other groups so they can be scored.',
    );
  }

  return {
    ...loadPresentation(),
    apiId: botToken ? Number(process.env.TG_API_ID ?? 0) : Number(required('TG_API_ID')),
    apiHash: botToken ? (process.env.TG_API_HASH?.trim() ?? '') : required('TG_API_HASH'),
    session,
    botToken,
    channel: process.env.PUMPGOD_CHANNEL?.trim() ?? '',
    warRoom: process.env.WAR_ROOM_CHAT?.trim() || undefined,
    channelTopic: topic('PUMPGOD_TOPIC'),
    warRoomTopic: topic('WAR_ROOM_TOPIC'),
    dedupeTtlMs: num('DEDUPE_TTL_SEC', 21_600) * 1000,
    metricsIntervalMs: num('METRICS_INTERVAL_SEC', 300) * 1000,
    catchupIntervalMs: num('CATCHUP_INTERVAL_SEC', 60) * 1000,
    trackIntervalMs: num('TRACK_INTERVAL_SEC', 60) * 1000,
  };
}

const VALID_MODES: SourceMode[] = ['auto', 'review', 'shadow'];

export function loadSources(): Source[] {
  if (!existsSync(SOURCES_PATH)) {
    throw new Error(
      `No config/sources.json. Copy config/sources.example.json and list the groups to track ` +
        `(run \`npm run dialogs\` to see the groups this account can already read).`,
    );
  }

  const parsed = JSON.parse(readFileSync(SOURCES_PATH, 'utf8')) as { sources?: unknown };
  if (!Array.isArray(parsed.sources)) throw new Error('config/sources.json must contain a "sources" array.');

  return parsed.sources.map((entry, i): Source => {
    const s = entry as Partial<Source>;
    if (!s.id) throw new Error(`sources[${i}] is missing "id".`);
    if (!s.peerId && !s.username) throw new Error(`source "${s.id}" needs a peerId or a username.`);
    if (s.mode && !VALID_MODES.includes(s.mode)) {
      throw new Error(`source "${s.id}" has invalid mode "${s.mode}". Use one of: ${VALID_MODES.join(', ')}.`);
    }
    return {
      id: s.id,
      label: s.label ?? s.id,
      peerId: s.peerId ? normalisePeerId(s.peerId) : undefined,
      username: s.username?.replace(/^@/, ''),
      mode: s.mode ?? 'review',
      enabled: s.enabled ?? true,
      minMarketCapUsd: s.minMarketCapUsd,
      maxMarketCapUsd: s.maxMarketCapUsd,
      chains: s.chains,
      mute: s.mute,
      notes: s.notes,
    };
  });
}

export { SOURCES_PATH, ROOT };
