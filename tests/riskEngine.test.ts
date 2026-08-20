import { describe, expect, it } from "vitest";
import { evaluate, shadowState } from "../src/risk/engine.js";
import { params } from "./fixtures.js";
import type { Candidate } from "../src/types.js";

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    underlying: "XLF",
    sector: "financials",
    contract: {
      occSymbol: "XLF260925P00044000",
      underlying: "XLF",
      type: "put",
      strike: 44,
      expiry: "2026-09-25",
      bid: 0.55,
      ask: 0.6,
      mid: 0.575,
      delta: -0.25,
      iv: 0.22,
      openInterest: 2500,
    },
    dte: 36,
    collateral: 4400,
    premiumAtBid: 55,
    premiumAtMid: 57.5,
    rocAnnualizedAtBid: 0.127,
    ivRank: { rank: 55, observations: 120, confident: true },
    screenNotes: [],
    ...overrides,
  };
}

describe("risk engine", () => {
  it("proposes when all checks pass", () => {
    const state = shadowState(50000, [], 0.15);
    const { verdict, checks } = evaluate(candidate(), state, params);
    expect(verdict).toBe("proposed");
    expect(checks.every((c) => c.pass)).toBe(true);
  });

  it("freezes on high realized vol", () => {
    const state = shadowState(50000, [], 0.42);
    const { verdict, checks } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
    expect(checks.find((c) => c.name === "vol-regime-freeze")!.pass).toBe(false);
  });

  it("freezes when vol data is unavailable (unknown regime is not calm)", () => {
    const state = shadowState(50000, [], null);
    const { verdict } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
  });

  it("enforces the per-name cap against open shadow exposure", () => {
    const state = shadowState(
      50000,
      [{ underlying: "XLF", sector: "financials", collateral: 4400 }],
      0.15,
    );
    // 4400 open + 4400 new = 8800 > 6000 cap
    const { verdict, checks } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
    expect(checks.find((c) => c.name === "per-name-cap")!.pass).toBe(false);
  });

  it("enforces the sector cap across names", () => {
    const state = shadowState(
      50000,
      [
        { underlying: "KRE", sector: "financials", collateral: 5000 },
        { underlying: "KBE", sector: "financials", collateral: 4000 },
      ],
      0.15,
    );
    // 9000 open + 4400 new = 13400 > 12500 sector cap (25% of 50k)
    const { verdict, checks } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
    expect(checks.find((c) => c.name === "sector-cap")!.pass).toBe(false);
  });

  it("enforces the cash buffer", () => {
    const open = Array.from({ length: 8 }, (_, i) => ({
      underlying: `ETF${i}`,
      sector: `sector${i}`,
      collateral: 5000,
    }));
    const state = shadowState(50000, open, 0.15);
    // cash 10000 - 4400 = 5600 < 5000 buffer? 5600 >= 5000 passes; push it over:
    open.push({ underlying: "ETF9", sector: "sector9", collateral: 1000 });
    const tighter = shadowState(50000, open, 0.15);
    const { verdict, checks } = evaluate(candidate(), tighter, params);
    expect(verdict).toBe("blocked");
    expect(checks.find((c) => c.name === "cash-buffer")!.pass).toBe(false);
  });

  it("blocks when the reconciler is red", () => {
    const state = shadowState(50000, [], 0.15);
    state.reconcilerGreen = false;
    const { verdict } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
  });

  it("halts on drawdown beyond 25% of high-water mark", () => {
    const state = shadowState(50000, [], 0.15);
    state.highWaterMark = 70000; // pool 50000 -> ~28.6% drawdown
    const { verdict, checks } = evaluate(candidate(), state, params);
    expect(verdict).toBe("blocked");
    expect(checks.find((c) => c.name === "drawdown-halt")!.pass).toBe(false);
  });
});
