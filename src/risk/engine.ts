import type { Candidate, Params, PortfolioState, RiskCheck } from "../types.js";

/**
 * The risk engine is law (PLAN.md 2.0 #4 / 2.5): ordered hard checks, no
 * override path. Pure function - fully unit-testable without market access.
 * A candidate must pass every check to become a proposal; failures are still
 * journaled as blocked proposals so the scoreboard sees them.
 */
export function evaluate(
  candidate: Candidate,
  state: PortfolioState,
  params: Params,
): { checks: RiskCheck[]; verdict: "proposed" | "blocked" } {
  const checks: RiskCheck[] = [];
  const pool = state.poolValue;

  checks.push({
    name: "reconciler-green",
    pass: state.reconcilerGreen,
    detail: state.reconcilerGreen
      ? "no unexplained broker divergence"
      : "state divergence unresolved - new trades frozen",
  });

  const drawdown = state.highWaterMark > 0 ? 1 - state.poolValue / state.highWaterMark : 0;
  const ddPass = drawdown < params.risk.maxDrawdownFractionOfHighWaterMark;
  checks.push({
    name: "drawdown-halt",
    pass: ddPass,
    detail: `drawdown ${(drawdown * 100).toFixed(1)}% of HWM (halt at ${params.risk.maxDrawdownFractionOfHighWaterMark * 100}%)`,
  });

  const rv = state.spyRealizedVol20dAnnualized;
  const volPass = rv !== null && rv <= params.risk.volFreeze.spyRealizedVol20dAnnualizedMax;
  checks.push({
    name: "vol-regime-freeze",
    pass: volPass,
    detail:
      rv === null
        ? "SPY realized vol unavailable - freezing new trades (unknown regime is not a calm regime)"
        : `SPY 20d realized vol ${(rv * 100).toFixed(1)}% (freeze above ${params.risk.volFreeze.spyRealizedVol20dAnnualizedMax * 100}%)`,
  });

  const nameExposure = (state.openCollateralByName[candidate.underlying] ?? 0) + candidate.collateral;
  const namePass = nameExposure <= params.risk.maxPositionFractionOfPool * pool;
  checks.push({
    name: "per-name-cap",
    pass: namePass,
    detail: `post-trade ${candidate.underlying} exposure $${nameExposure.toFixed(0)} vs cap $${(params.risk.maxPositionFractionOfPool * pool).toFixed(0)}`,
  });

  const sectorExposure = (state.openCollateralBySector[candidate.sector] ?? 0) + candidate.collateral;
  const sectorPass = sectorExposure <= params.risk.maxSectorFractionOfPool * pool;
  checks.push({
    name: "sector-cap",
    pass: sectorPass,
    detail: `post-trade ${candidate.sector} exposure $${sectorExposure.toFixed(0)} vs cap $${(params.risk.maxSectorFractionOfPool * pool).toFixed(0)}`,
  });

  const cashAfter = state.cash - candidate.collateral;
  const cashPass = cashAfter >= params.risk.minCashBufferFraction * pool;
  checks.push({
    name: "cash-buffer",
    pass: cashPass,
    detail: `post-trade cash $${cashAfter.toFixed(0)} vs buffer $${(params.risk.minCashBufferFraction * pool).toFixed(0)}`,
  });

  const verdict = checks.every((c) => c.pass) ? "proposed" : "blocked";
  return { checks, verdict };
}

/** Shadow-mode portfolio state builder: open shadow proposals stand in for positions. */
export function shadowState(
  poolValue: number,
  openProposals: { underlying: string; sector: string; collateral: number }[],
  spyRealizedVol20dAnnualized: number | null,
): PortfolioState {
  const byName: Record<string, number> = {};
  const bySector: Record<string, number> = {};
  let committed = 0;
  for (const p of openProposals) {
    byName[p.underlying] = (byName[p.underlying] ?? 0) + p.collateral;
    bySector[p.sector] = (bySector[p.sector] ?? 0) + p.collateral;
    committed += p.collateral;
  }
  return {
    poolValue,
    highWaterMark: poolValue, // Phase 1: flat pool; real HWM tracking arrives with paper P&L in Phase 2
    cash: poolValue - committed,
    openCollateralByName: byName,
    openCollateralBySector: bySector,
    spyRealizedVol20dAnnualized,
    reconcilerGreen: true, // Phase 1: no broker, nothing to diverge from; Phase 2 wires the real reconciler
  };
}
