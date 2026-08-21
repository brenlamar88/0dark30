import type { RiskCheck } from "../types.js";

/**
 * Plain-English purposes for every risk check - shown alongside the raw
 * numbers so a verdict is an explanation, not a code. Keep these in sync
 * with the checks in risk/engine.ts.
 */
const CHECK_PURPOSE: Record<string, string> = {
  "reconciler-green":
    "The system's records must match the broker exactly before any new risk is added - if they disagree, every other number here could be fiction.",
  "drawdown-halt":
    "If the pool falls 25% from its high-water mark, all new trades stop until a human reviews and journals a reason to continue. Prevents digging while in a hole.",
  "vol-regime-freeze":
    "When the market itself turns violent (SPY's realized volatility above 30%), premium looks richest exactly when gap risk is worst - so new premium-selling pauses.",
  "per-name-cap":
    "No more than 12% of the pool may be exposed to one underlying. Options premiums are small; one bad gap in a concentrated name would not be.",
  "sector-cap":
    "No more than 25% of the pool in one sector - names in a sector gap down together, so per-name caps alone are not enough.",
  "cash-buffer":
    "At least 10% of the pool stays in cash at all times, so a drawdown never forces selling positions at the worst moment.",
};

export function explainCheck(check: RiskCheck): string {
  return CHECK_PURPOSE[check.name] ?? "";
}

/** One-line human headline for a verdict. */
export function verdictHeadline(checks: RiskCheck[]): string {
  const failed = checks.filter((c) => !c.pass);
  if (failed.length === 0) {
    return `Cleared all ${checks.length} risk checks.`;
  }
  const names = failed.map((c) => shortName(c.name)).join(" and ");
  return `Blocked by ${names}.`;
}

export function shortName(checkName: string): string {
  const map: Record<string, string> = {
    "reconciler-green": "the reconciler freeze",
    "drawdown-halt": "the drawdown halt",
    "vol-regime-freeze": "the volatility freeze",
    "per-name-cap": "the single-name cap",
    "sector-cap": "the sector cap",
    "cash-buffer": "the cash buffer",
  };
  return map[checkName] ?? checkName;
}
