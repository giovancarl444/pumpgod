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

export interface AppConfig {
  apiId: number;
  apiHash: string;
  session: string;
  channel: string;
  warRoom?: string;
  live: boolean;
  showSource: boolean;
  dedupeTtlMs: number;
  enrichEnabled: boolean;
  enrichTimeoutMs: number;
  footer: string;
  metricsIntervalMs: number;
}

export function loadConfig(): AppConfig {
  return {
    apiId: Number(required('TG_API_ID')),
    apiHash: required('TG_API_HASH'),
    session: process.env.TG_SESSION?.trim() ?? '',
    channel: process.env.PUMPGOD_CHANNEL?.trim() ?? '',
    warRoom: process.env.WAR_ROOM_CHAT?.trim() || undefined,
    live: bool('LIVE', false),
    showSource: bool('SHOW_SOURCE', false),
    dedupeTtlMs: num('DEDUPE_TTL_SEC', 21_600) * 1000,
    enrichEnabled: bool('ENRICH_ENABLED', true),
    enrichTimeoutMs: num('ENRICH_TIMEOUT_MS', 2500),
    footer: process.env.FOOTER?.trim() ?? 'NFA · DYOR',
    metricsIntervalMs: num('METRICS_INTERVAL_SEC', 300) * 1000,
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
