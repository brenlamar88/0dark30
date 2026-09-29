import type { BrokerPosition } from "../broker/types.js";
import type { OrderRecord } from "./store.js";
import { parseOccSymbol } from "../data/alpaca.js";

export interface HeldShares {
  underlying: string;
  shares: number;
  basis: number; // per share: strike - premium collected on the assigned put
  acquiredAt: string;
  viaOcc: string;
}

export interface ReconcileResult {
  green: boolean;
  divergences: string[];
  /** Newly-recognized put assignments: expected short put gone, shares appeared. */
  assignments: HeldShares[];
  /** Held shares gone with an expired/assigned short call to explain them. */
  calledAway: string[]; // underlyings
}

/**
 * State reconciliation (PLAN.md 2.0 #5 / Part 1 #8): the broker is the source
 * of truth; our records must fully explain every broker position. Pure
 * function so it is unit-testable without a broker.
 *
 * The wheel's own mechanics are recognized rather than frozen:
 * - short put missing at broker + >=100 unclaimed shares of its underlying
 *   present -> ASSIGNMENT (the wheel's entry into share ownership);
 * - held shares missing at broker + a filled short call past expiry ->
 *   CALLED AWAY (the wheel's exit).
 * Anything else unexplained still freezes new trades.
 */
export function reconcile(
  brokerPositions: BrokerPosition[],
  orders: OrderRecord[],
  heldShares: HeldShares[] = [],
  todayIso?: string,
): ReconcileResult {
  const expected = new Map<string, number>();
  for (const o of orders) {
    if (o.filledQty <= 0) continue;
    const signed = o.side === "sell" ? -o.filledQty : o.filledQty;
    expected.set(o.occSymbol, (expected.get(o.occSymbol) ?? 0) + signed);
  }

  const divergences: string[] = [];
  const assignments: HeldShares[] = [];
  const calledAway: string[] = [];
  const today = todayIso ?? new Date().toISOString().slice(0, 10);

  const brokerOptions = new Map<string, number>();
  const brokerEquity = new Map<string, number>();
  for (const p of brokerPositions) {
    if (p.assetClass === "option") brokerOptions.set(p.symbol, p.qty);
    else brokerEquity.set(p.symbol, (brokerEquity.get(p.symbol) ?? 0) + p.qty);
  }

  // Shares already recognized in prior cycles claim broker equity first.
  const unclaimedEquity = new Map(brokerEquity);
  for (const h of heldShares) {
    const have = unclaimedEquity.get(h.underlying) ?? 0;
    if (have >= h.shares) {
      unclaimedEquity.set(h.underlying, have - h.shares);
    } else {
      // Held shares vanished: called away if a filled short call past expiry explains it.
      const call = orders.find((o) => {
        if (o.side !== "sell" || o.filledQty <= 0) return false;
        const parsed = parseOccSymbol(o.occSymbol);
        return (
          parsed !== null &&
          parsed.type === "call" &&
          parsed.underlying === h.underlying &&
          parsed.expiry <= today &&
          (expected.get(o.occSymbol) ?? 0) < 0 &&
          !brokerOptions.has(o.occSymbol)
        );
      });
      if (call) {
        calledAway.push(h.underlying);
        expected.set(call.occSymbol, 0); // the call's disappearance is explained too
      } else {
        divergences.push(`held ${h.shares} ${h.underlying} shares missing at broker with no expired short call to explain it`);
      }
    }
  }

  // Options the records expect vs the broker.
  for (const [occ, want] of expected) {
    const have = brokerOptions.get(occ) ?? 0;
    if (want === have) continue;
    const parsed = parseOccSymbol(occ);
    if (parsed && parsed.type === "put" && want < 0 && have === 0) {
      // Already recognized in a prior cycle: the shares store explains this put.
      if (heldShares.some((h) => h.viaOcc === occ)) continue;
      const needShares = 100 * Math.abs(want);
      const avail = unclaimedEquity.get(parsed.underlying) ?? 0;
      if (avail >= needShares) {
        // Assignment: the short put became shares. Basis = strike - premium collected.
        const entry = orders.find((o) => o.occSymbol === occ && o.side === "sell" && o.filledQty > 0);
        unclaimedEquity.set(parsed.underlying, avail - needShares);
        assignments.push({
          underlying: parsed.underlying,
          shares: needShares,
          basis: round2(parsed.strike - (entry?.filledAvgPrice ?? 0)),
          acquiredAt: today,
          viaOcc: occ,
        });
        continue;
      }
      if (parsed.expiry <= today && avail === 0 && !brokerEquity.has(parsed.underlying)) {
        // Expired worthless (OTM): put gone, no shares - the position simply ended.
        continue;
      }
    }
    divergences.push(`position ${occ}: broker qty ${have}, records explain ${want}`);
  }

  // Any option position the records never mention.
  for (const [occ, qty] of brokerOptions) {
    if (!expected.has(occ)) divergences.push(`unexpected option position ${occ} qty ${qty}`);
  }
  // Any equity the claims above did not account for.
  for (const [sym, qty] of unclaimedEquity) {
    if (qty !== 0) divergences.push(`unexplained equity ${sym} qty ${qty}`);
  }

  return { green: divergences.length === 0, divergences, assignments, calledAway };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
