import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { Source, SourceMode } from './types';

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
  channel: string;
  warRoom?: string;
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

export function loadSocial(): SocialConfig {
  return {
    channelUrl: process.env.CHANNEL_URL?.trim() || undefined,
    minMultiple: num('X_MIN_MULTIPLE', 5),
    dailyRecap: bool('X_DAILY_RECAP', true),
    postIntervalMs: num('X_POST_INTERVAL_SEC', 300) * 1000,
  };
}

export function loadConfig(): AppConfig {
  return {
    ...loadPresentation(),
    apiId: Number(required('TG_API_ID')),
    apiHash: required('TG_API_HASH'),
    session: process.env.TG_SESSION?.trim() ?? '',
    channel: process.env.PUMPGOD_CHANNEL?.trim() ?? '',
    warRoom: process.env.WAR_ROOM_CHAT?.trim() || undefined,
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
