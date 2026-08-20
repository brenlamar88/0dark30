import { describe, expect, it } from "vitest";
import { reconcile } from "../src/exec/reconciler.js";
import type { BrokerPosition } from "../src/broker/types.js";
import type { OrderRecord } from "../src/exec/store.js";

function order(overrides: Partial<OrderRecord>): OrderRecord {
  return {
    id: "o1",
    proposalId: "p1",
    intent: "open-csp",
    occSymbol: "XLF260925P00044000",
    side: "sell",
    qty: 1,
    limitPrice: 0.55,
    status: "filled",
    brokerOrderId: "b1",
    filledQty: 1,
    filledAvgPrice: 0.55,
    createdAt: "2026-08-20T14:00:00Z",
    updatedAt: "2026-08-20T14:05:00Z",
    ...overrides,
  };
}

const shortPut: BrokerPosition = {
  symbol: "XLF260925P00044000",
  qty: -1,
  avgEntryPrice: 0.55,
  assetClass: "option",
};

describe("reconciler", () => {
  it("is green when filled orders explain broker positions", () => {
    const r = reconcile([shortPut], [order({})]);
    expect(r.green).toBe(true);
  });

  it("is green with no positions and no filled orders", () => {
    expect(reconcile([], [order({ status: "working", filledQty: 0 })]).green).toBe(true);
  });

  it("flags a broker position we have no record of (manual trade)", () => {
    const r = reconcile([shortPut], []);
    expect(r.green).toBe(false);
    expect(r.divergences[0]).toContain("XLF260925P00044000");
  });

  it("flags quantity mismatches", () => {
    const r = reconcile([{ ...shortPut, qty: -2 }], [order({})]);
    expect(r.green).toBe(false);
  });

  it("flags a recorded position the broker no longer shows (expiry/assignment)", () => {
    const r = reconcile([], [order({})]);
    expect(r.green).toBe(false);
    expect(r.divergences[0]).toContain("broker shows none");
  });

  it("is green again after a filled close nets the position to zero", () => {
    const close = order({ id: "o2", side: "buy", intent: "close-profit-target", filledAvgPrice: 0.27 });
    expect(reconcile([], [order({}), close]).green).toBe(true);
  });

  it("flags unexpected equity positions (assignment landed)", () => {
    const r = reconcile(
      [{ symbol: "XLF", qty: 100, avgEntryPrice: 44, assetClass: "equity" }],
      [order({})],
    );
    expect(r.green).toBe(false);
    expect(r.divergences.some((d) => d.includes("equity"))).toBe(true);
  });
});
