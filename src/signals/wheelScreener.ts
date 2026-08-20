import type { Candidate, CandidateInput, Params } from "../types.js";
import { daysBetween } from "../config.js";

/**
 * Mechanical CSP screener, rule version from params. Deterministic: same
 * inputs -> same outputs. All thresholds live in config/params.v1.json;
 * changing them starts a new track record (PLAN.md 2.0 #1).
 */
export function screenCsp(input: CandidateInput, params: Params, today: string): Candidate | null {
  const notes: string[] = [];
  const { entry, puts, ivRank, earningsInWindow } = input;

  // Catalyst avoidance is a hard rule for names that have catalysts. Unknown
  // (null) is treated as failing, not passing - PLAN.md 2.3.
  if (entry.hasEarnings) {
    if (earningsInWindow === null) {
      notes.push("earnings-unknown: no calendar provider; blocked for hasEarnings symbol");
      return null;
    }
    if (earningsInWindow) {
      notes.push("earnings inside expiry window");
      return null;
    }
  }

  const eligible = puts.filter((p) => {
    const dte = daysBetween(today, p.expiry);
    if (dte < params.csp.dteMin || dte > params.csp.dteMax) return false;
    const absDelta = p.delta === null ? null : Math.abs(p.delta);
    if (absDelta === null || absDelta < params.csp.deltaMin || absDelta > params.csp.deltaMax) return false;
    if (p.bid < params.screen.minBid) return false;
    if (p.mid <= 0) return false;
    if ((p.ask - p.bid) / p.mid > params.screen.maxSpreadFractionOfMid) return false;
    if (p.openInterest !== null && p.openInterest < params.screen.minOpenInterest) return false;
    const collateral = p.strike * 100;
    if (collateral > params.risk.maxPositionFractionOfPool * params.pool.simulatedValueUsd) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  // IV-rank gate: hard once history is confident, advisory while bootstrapping.
  if (ivRank.confident && ivRank.rank !== null && ivRank.rank < params.screen.ivRankMin) {
    return null;
  }
  if (!ivRank.confident) {
    notes.push(
      `iv-rank low confidence (${ivRank.observations}/${params.screen.ivRankMinObservations} observations) - threshold not yet enforced`,
    );
  }

  // Rank on annualized return-on-capital at the BID (conservative fill).
  const scored = eligible
    .map((contract) => {
      const dte = daysBetween(today, contract.expiry);
      const collateral = contract.strike * 100;
      const premiumAtBid = contract.bid * 100;
      const roc = (premiumAtBid / collateral) * (365 / dte);
      return { contract, dte, collateral, premiumAtBid, roc };
    })
    .sort((a, b) => b.roc - a.roc);

  const best = scored[0]!;
  return {
    underlying: entry.symbol,
    sector: entry.sector,
    contract: best.contract,
    dte: best.dte,
    collateral: best.collateral,
    premiumAtBid: best.premiumAtBid,
    premiumAtMid: best.contract.mid * 100,
    rocAnnualizedAtBid: best.roc,
    ivRank,
    screenNotes: notes,
  };
}
