import type { BrokerPosition } from "../broker/types.js";
import type { OrderRecord } from "./store.js";

export interface ReconcileResult {
  green: boolean;
  divergences: string[];
}

/**
 * State reconciliation (PLAN.md 2.0 #5 / Part 1 #8): the broker is the source
 * of truth; our order records must fully explain every broker position. Pure
 * function so it is unit-testable without a broker.
 *
 * Expected net position per OCC symbol = sum of our filled order quantities
 * (sell = -qty, buy = +qty). Any broker option position that differs -
 * including positions we have no record of (e.g. a manual trade in the paper
 * account) - is a divergence, and divergence freezes new trades.
 */
export function reconcile(brokerPositions: BrokerPosition[], orders: OrderRecord[]): ReconcileResult {
  const expected = new Map<string, number>();
  for (const o of orders) {
    if (o.filledQty <= 0) continue;
    const signed = o.side === "sell" ? -o.filledQty : o.filledQty;
    expected.set(o.occSymbol, (expected.get(o.occSymbol) ?? 0) + signed);
  }

  const divergences: string[] = [];
  const seen = new Set<string>();
  for (const p of brokerPositions) {
    if (p.assetClass !== "option") {
      // Assigned shares land as equity positions; Phase 2 CSP-only flow should
      // never hold equities. An assignment is real state the covered-call
      // module doesn't exist for yet, so it freezes rather than being ignored.
      divergences.push(`unexpected equity position ${p.symbol} qty ${p.qty} (assignment?)`);
      continue;
    }
    seen.add(p.symbol);
    const want = expected.get(p.symbol) ?? 0;
    if (want !== p.qty) {
      divergences.push(`position ${p.symbol}: broker qty ${p.qty}, records explain ${want}`);
    }
  }
  for (const [symbol, want] of expected) {
    if (want !== 0 && !seen.has(symbol)) {
      divergences.push(`records expect ${symbol} qty ${want}, broker shows none (expired/assigned?)`);
    }
  }
  return { green: divergences.length === 0, divergences };
}
