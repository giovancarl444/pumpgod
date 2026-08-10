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

/**
 * What the mint account itself says. Facts, not judgements: an authority is set or it is not.
 *
 * Both authorities are `undefined` when revoked, which is the healthy state, and hold an address
 * when they are live — stored as the address rather than a boolean so the war room can say *who*
 * still holds the key.
 */
export interface MintFacts {
  /** Set means the supply is not fixed and more can be printed at will. */
  mintAuthority?: string;
  /**
   * Set means someone can freeze a token account. A frozen holder cannot sell at any price,
   * which makes this the purest rug on the chain: the chart never has to move for the money to
   * be gone. It is one field, and almost nobody checks it.
   */
  freezeAuthority?: string;
  /**
   * A u64, which does not fit in a JavaScript number — BONK alone is 8.8e18, well past the
   * 9.007e15 where doubles stop counting accurately. Holding this as a `number` would quietly
   * corrupt every share calculation and only for the large-supply memecoins that are the
   * entire subject.
   */
  supply: bigint;
  decimals: number;
}

/** How the supply is spread, once the pools are taken out of the picture. */
export interface HolderFacts {
  /** The largest single non-programmatic holder, as a fraction of supply. */
  topShare: number;
  /** The ten largest together. One wallet at 30% and ten at 31% are different situations. */
  top10Share: number;
  /** How many of the top accounts were pools or programs rather than people. */
  poolAccounts: number;
  /** Holders actually examined. The RPC returns at most twenty, so this is never the whole book. */
  examined: number;
}

/**
 * Everything the chain was asked, with each answer allowed to be missing on its own.
 *
 * A missing field means the question could not be answered, which is never the same as the
 * answer being good — the two are separated everywhere downstream, because a screen that lets
 * silence read as a pass is worse than no screen at all.
 */
export interface ChainFacts {
  mint?: MintFacts;
  holders?: HolderFacts;
}

export interface ParsedCall {
  token: TokenRef;
  /** Pair/pool address, when a chart link exposed one. Distinct from the token address. */
  pairAddress?: string;
  name?: string;
  ticker?: string;
  stats: Stats;
  /** The coin's own artwork, as the market indexed it. Only ever set from live market data —
   *  a source group's message cannot supply one, so a relayed call has none until enrichment. */
  imageUrl?: string;
  /** Every address seen, best-first. Kept for debugging bad parses. */
  candidates: TokenRef[];
  /**
   * What the chain said, when we had time to ask. Absent on the relay path, where a round trip
   * would cost more than it is worth, and present on `/signal`, which is racing nobody.
   *
   * It rides on the call rather than being passed to the screen separately so that it survives
   * enrichment and reaches every later `assess()` unchanged — a fact that stopped applying
   * halfway through a call's life would be worse than never having read it.
   */
  onchain?: ChainFacts;
}

export type RiskLevel = 'clear' | 'caution' | 'danger';

export interface RiskFlag {
  code:
    | 'dead'
    | 'thin'
    | 'ratio'
    | 'churn'
    | 'late'
    | 'weak-parse'
    | 'unknown-depth'
    /** Someone can still print supply. */
    | 'mint-authority'
    /** Someone can stop the buyer selling. The one flag that means "do not touch". */
    | 'freeze-authority'
    /** One wallet, pools excluded, holds enough to end the token by itself. */
    | 'whale'
    /** The mint could not be read at all, so neither authority is known either way. */
    | 'unknown-mint';
  /** Rendered to a human who has about a second to decide, so it states the number. */
  detail: string;
  level: 'caution' | 'danger';
}

/** Whether a call is tradable. Deliberately says nothing about whether it will run. */
export interface RiskRead {
  level: RiskLevel;
  flags: RiskFlag[];
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
  /**
   * A person typed this address at us, rather than us lifting it out of somebody's message.
   * Only `/signal` sets it, and it exempts the call from the screen's veto — see `route`.
   */
  commanded?: boolean;
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
  /** Tradability screen. Recomputed on real market data once enrichment lands. */
  risk: RiskRead;
  /** Stats are already live market data rather than a source's claim, so there is nothing to add. */
  enriched?: boolean;
}
