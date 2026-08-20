import type { OptionQuote, Params, UniverseEntry } from "../src/types.js";

export const params: Params = {
  ruleVersion: "wheel-v1-test",
  pool: { simulatedValueUsd: 50000 },
  csp: { dteMin: 30, dteMax: 45, deltaMin: 0.2, deltaMax: 0.3, profitTargetFraction: 0.5, manageAtDte: 21 },
  screen: {
    maxSpreadFractionOfMid: 0.1,
    minOpenInterest: 500,
    minBid: 0.05,
    ivRankMin: 30,
    ivRankMinObservations: 60,
    earningsBufferDays: 1,
  },
  risk: {
    maxPositionFractionOfPool: 0.12,
    maxSectorFractionOfPool: 0.25,
    minCashBufferFraction: 0.1,
    maxDrawdownFractionOfHighWaterMark: 0.25,
    volFreeze: { spyRealizedVol20dAnnualizedMax: 0.3 },
    proposalTtlHours: 4,
  },
  maxProposalsPerDay: 5,
};

export const xlf: UniverseEntry = { symbol: "XLF", sector: "financials", hasEarnings: false };

export function put(overrides: Partial<OptionQuote>): OptionQuote {
  const base: OptionQuote = {
    occSymbol: "XLF260925P00044000",
    underlying: "XLF",
    type: "put",
    strike: 44,
    expiry: "2026-09-25", // 36 DTE from the fixed test date
    bid: 0.55,
    ask: 0.6,
    mid: 0.575,
    delta: -0.25,
    iv: 0.22,
    openInterest: 2500,
  };
  return { ...base, ...overrides };
}

export const TODAY = "2026-08-20";
