export interface UniverseEntry {
  symbol: string;
  sector: string;
  hasEarnings: boolean;
}

export interface Params {
  ruleVersion: string;
  pool: { simulatedValueUsd: number; comment?: string };
  csp: {
    dteMin: number;
    dteMax: number;
    deltaMin: number;
    deltaMax: number;
    profitTargetFraction: number;
    manageAtDte: number;
  };
  screen: {
    maxSpreadFractionOfMid: number;
    minOpenInterest: number;
    minBid: number;
    ivRankMin: number;
    ivRankMinObservations: number;
    earningsBufferDays: number;
  };
  risk: {
    maxPositionFractionOfPool: number;
    maxSectorFractionOfPool: number;
    minCashBufferFraction: number;
    maxDrawdownFractionOfHighWaterMark: number;
    volFreeze: { spyRealizedVol20dAnnualizedMax: number; comment?: string };
    proposalTtlHours: number;
  };
  maxProposalsPerDay: number;
}

export interface OptionQuote {
  occSymbol: string;
  underlying: string;
  type: "put" | "call";
  strike: number;
  expiry: string; // YYYY-MM-DD
  bid: number;
  ask: number;
  mid: number;
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
}

export interface IvRank {
  rank: number | null; // 0-100 percentile of today's ATM IV vs trailing history
  observations: number;
  confident: boolean;
}

export interface CandidateInput {
  entry: UniverseEntry;
  price: number;
  puts: OptionQuote[];
  ivRank: IvRank;
  earningsInWindow: boolean | null; // null = unknown (provider unavailable)
}

export interface Candidate {
  underlying: string;
  sector: string;
  contract: OptionQuote;
  dte: number;
  collateral: number;
  premiumAtBid: number; // per contract, dollars
  premiumAtMid: number;
  rocAnnualizedAtBid: number;
  ivRank: IvRank;
  screenNotes: string[];
}

export interface RiskCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface PortfolioState {
  poolValue: number;
  highWaterMark: number;
  cash: number;
  // Phase 1 shadow mode: no real positions; shadow-open proposals stand in so
  // the concentration checks are exercised against realistic state.
  openCollateralByName: Record<string, number>;
  openCollateralBySector: Record<string, number>;
  spyRealizedVol20dAnnualized: number | null;
  reconcilerGreen: boolean;
}

export interface LlmFlag {
  flag: string;
  severity: "info" | "warning" | "veto";
  source: string;
}

export interface LlmAnalysis {
  rationale: string;
  flags: LlmFlag[];
  veto: boolean;
}

export interface Proposal {
  id: string;
  date: string; // YYYY-MM-DD
  ruleVersion: string;
  strategy: "csp";
  underlying: string;
  sector: string;
  occSymbol: string;
  expiry: string;
  strike: number;
  dte: number;
  delta: number | null;
  bid: number;
  ask: number;
  mid: number;
  collateral: number;
  premiumAtMid: number;
  rocAnnualizedAtBid: number;
  ivRank: IvRank;
  checks: RiskCheck[];
  verdict: "proposed" | "blocked";
  createdAt?: string; // ISO; absent on proposals from before Phase 2
  ttlHours: number;
  screenNotes: string[];
  llm: LlmAnalysis | null;
  // shadow-tracking fields, maintained by postclose
  shadowStatus: "open" | "closed" | "blocked";
  entryMid: number;
  currentMid: number | null;
  shadowPnl: number | null;
  closedReason: string | null;
}

export interface JournalEvent {
  ts: string;
  type: string;
  ruleVersion: string;
  payload: unknown;
}
