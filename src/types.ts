export type Chain =
  | 'solana'
  | 'ethereum'
  | 'base'
  | 'bsc'
  | 'arbitrum'
  | 'polygon'
  | 'avalanche'
  | 'blast'
  | 'sui'
  | 'tron'
  | 'ton'
  | 'hyperliquid'
  | 'robinhood'
  | 'unknown';

export type AddressKind = 'evm' | 'solana' | 'sui' | 'tron' | 'ton';

/** A token address lifted out of a message, plus how confident we are it is the subject. */
export interface TokenRef {
  address: string;
  kind: AddressKind;
  chain: Chain;
  /** Where in the message we found it — drives confidence ranking. */
  origin: 'labelled' | 'link' | 'bare' | 'entity';
  /** 0..1. Labelled `CA:` beats a bare address beats an address scraped from a chart link. */
  confidence: number;
}

/** Numeric stats a source group volunteered. Never trusted for trading, only for display. */
export interface Stats {
  marketCapUsd?: number;
  liquidityUsd?: number;
  volumeUsd?: number;
  ageText?: string;
  holders?: number;
  priceUsd?: number;
}

export interface ParsedCall {
  token: TokenRef;
  /** Pair/pool address, when a chart link exposed one. Distinct from the token address. */
  pairAddress?: string;
  name?: string;
  ticker?: string;
  stats: Stats;
  /** Every address seen, best-first. Kept for debugging bad parses. */
  candidates: TokenRef[];
}

export type SourceMode =
  /** Fire straight to the public channel with zero human input. Fastest path. */
  | 'auto'
  /** Post to the war room with one-tap approve. Human in the loop. */
  | 'review'
  /** Parse and journal, never surface. Use while you evaluate a new source. */
  | 'shadow';

export interface Source {
  /** Stable key used in logs, metrics and dedupe attribution. */
  id: string;
  label: string;
  /** Telegram peer id of the channel/group, as a string. Resolved once at boot. */
  peerId?: string;
  /** @username, used only to resolve peerId at boot. */
  username?: string;
  mode: SourceMode;
  enabled: boolean;
  /** Ignore calls whose reported market cap sits outside this window. */
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  /** Restrict to these chains. Empty/absent means all. */
  chains?: Chain[];
  /** Drop messages matching any of these (case-insensitive substrings). */
  mute?: string[];
  notes?: string;
}

/** Timestamps in ms from `performance.now()`, plus wall-clock for the journal. */
export interface Timings {
  /** Telegram's own message timestamp, unix seconds. 1s resolution — indicative only. */
  messageUnix: number;
  /** Our process received the update. This is t=0 for everything we control. */
  recvAt: number;
  parsedAt?: number;
  /** We handed the send to the socket. `dispatchAt - recvAt` is our controllable latency. */
  dispatchAt?: number;
  /** Telegram acked the send. `ackAt - recvAt` is end-to-end. */
  ackAt?: number;
  enrichedAt?: number;
  wallClockMs: number;
}

export interface Signal {
  id: string;
  source: Source;
  chatId: string;
  messageId: number;
  rawText: string;
  call: ParsedCall;
  timings: Timings;
  /** Sources that independently called this same token inside the dedupe window. */
  confirmations: string[];
  /** How long ago the source posted it. Non-trivial only for recovered messages. */
  ageSec: number;
  /** Too old to auto-fire; must be reviewed by a human however the source is configured. */
  stale: boolean;
}
