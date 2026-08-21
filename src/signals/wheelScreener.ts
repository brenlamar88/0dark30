import type { Candidate, CandidateInput, Params } from "../types.js";
import { daysBetween } from "../config.js";

export interface ScreenResult {
  candidate: Candidate | null;
  /** Plain-English reason the symbol produced no candidate (null when it did). */
  rejection: string | null;
}

/**
 * Mechanical CSP screener, rule version from params. Deterministic: same
 * inputs -> same outputs. All thresholds live in config/params.v1.json;
 * changing them starts a new track record (PLAN.md 2.0 #1). When no
 * candidate survives, the result says WHICH filter eliminated the symbol -
 * a verdict is only useful if it explains itself.
 */
export function screenCsp(input: CandidateInput, params: Params, today: string): ScreenResult {
  const notes: string[] = [];
  const { entry, puts, ivRank, earningsInWindow } = input;

  // Catalyst avoidance is a hard rule for names that have catalysts. Unknown
  // (null) is treated as failing, not passing - PLAN.md 2.3.
  if (entry.hasEarnings) {
    if (earningsInWindow === null) {
      return {
        candidate: null,
        rejection: "earnings date unknown (no calendar provider) - an unknown catalyst is treated as a live one",
      };
    }
    if (earningsInWindow) {
      return { candidate: null, rejection: "earnings inside the expiry window - hard catalyst-avoidance rule" };
    }
  }

  // Count why contracts fall out so the rejection names the dominant filter.
  const why = { dte: 0, delta: 0, quote: 0, spread: 0, oi: 0, collateral: 0 };
  const maxCollateral = params.risk.maxPositionFractionOfPool * params.pool.simulatedValueUsd;
  const eligible = puts.filter((p) => {
    const dte = daysBetween(today, p.expiry);
    if (dte < params.csp.dteMin || dte > params.csp.dteMax) return why.dte++, false;
    const absDelta = p.delta === null ? null : Math.abs(p.delta);
    if (absDelta === null || absDelta < params.csp.deltaMin || absDelta > params.csp.deltaMax)
      return why.delta++, false;
    if (p.bid < params.screen.minBid || p.mid <= 0) return why.quote++, false;
    if ((p.ask - p.bid) / p.mid > params.screen.maxSpreadFractionOfMid) return why.spread++, false;
    if (p.openInterest !== null && p.openInterest < params.screen.minOpenInterest) return why.oi++, false;
    if (p.strike * 100 > maxCollateral) return why.collateral++, false;
    return true;
  });

  if (eligible.length === 0) {
    const reasons: string[] = [];
    if (puts.length === 0) reasons.push("no quoted puts in the 30-45 DTE window at all");
    if (why.collateral > 0 && why.collateral >= puts.length - why.dte)
      reasons.push(`every strike needs more than $${maxCollateral.toFixed(0)} collateral (share price too high for the 12% position cap)`);
    if (why.delta > 0) reasons.push(`${why.delta} contracts outside the ${params.csp.deltaMin}-${params.csp.deltaMax} delta band`);
    if (why.spread > 0) reasons.push(`${why.spread} with bid-ask spreads over ${params.screen.maxSpreadFractionOfMid * 100}% of mid (too expensive to trade)`);
    if (why.oi > 0) reasons.push(`${why.oi} with open interest under ${params.screen.minOpenInterest} (too thin)`);
    if (why.quote > 0) reasons.push(`${why.quote} with no usable quote`);
    if (why.dte > 0 && reasons.length === 0) reasons.push("no expiry inside the 30-45 DTE window");
    return {
      candidate: null,
      rejection: `no contract survived the screen: ${reasons.join("; ") || "all filtered"}`,
    };
  }

  // IV-rank gate: hard once history is confident, advisory while bootstrapping.
  if (ivRank.confident && ivRank.rank !== null && ivRank.rank < params.screen.ivRankMin) {
    return {
      candidate: null,
      rejection: `IV rank ${ivRank.rank} below ${params.screen.ivRankMin} - premium is cheap relative to this ETF's own year, so selling it is poorly paid right now`,
    };
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
    candidate: {
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
    },
    rejection: null,
  };
}
