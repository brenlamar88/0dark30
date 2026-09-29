import type { OptionQuote, Params } from "../types.js";
import { daysBetween } from "../config.js";
import type { SharesRecord } from "../exec/store.js";

export interface CcResult {
  contract: OptionQuote | null;
  notes: string[];
  rejection: string | null;
}

/**
 * Covered-call leg of the wheel (PLAN.md 2.3): once assigned, sell 30-45 DTE
 * calls at >=0.20 delta, above cost basis where available, same liquidity
 * screen as CSPs. Selling below basis converts a paper loss into a realized
 * one if called away, so below-basis strikes are proposed only when nothing
 * above basis qualifies - loudly annotated, never silently.
 */
export function screenCoveredCall(
  holding: SharesRecord,
  calls: OptionQuote[],
  params: Params,
  today: string,
): CcResult {
  const notes: string[] = [];
  const eligible = calls.filter((c) => {
    const dte = daysBetween(today, c.expiry);
    if (dte < params.csp.dteMin || dte > params.csp.dteMax) return false;
    const d = c.delta;
    if (d === null || d < params.csp.deltaMin || d > params.csp.deltaMax) return false;
    if (c.bid < params.screen.minBid || c.mid <= 0) return false;
    if ((c.ask - c.bid) / c.mid > params.screen.maxSpreadFractionOfMid) return false;
    if (c.openInterest !== null && c.openInterest < params.screen.minOpenInterest) return false;
    return true;
  });
  if (eligible.length === 0) {
    return { contract: null, notes, rejection: "no call inside the delta/DTE/liquidity screen" };
  }
  const aboveBasis = eligible.filter((c) => c.strike >= holding.basis);
  const pool = aboveBasis.length > 0 ? aboveBasis : eligible;
  if (aboveBasis.length === 0) {
    notes.push(
      `NO STRIKE ABOVE BASIS $${holding.basis.toFixed(2)} qualifies - best available is below basis, so a call-away would realize a loss on the shares. Approve only deliberately.`,
    );
  }
  // Rank by annualized premium yield on the share basis.
  const scored = pool
    .map((c) => ({ c, roc: ((c.bid * 100) / (holding.basis * 100)) * (365 / daysBetween(today, c.expiry)) }))
    .sort((a, b) => b.roc - a.roc);
  return { contract: scored[0]!.c, notes, rejection: null };
}
