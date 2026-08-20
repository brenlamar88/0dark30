import { describe, expect, it } from "vitest";
import { normCdf, normInv, putPrice, strikeForPutDelta } from "../src/backtest/bs.js";
import { backtestSymbol, stats, type BtBar } from "../src/backtest/engine.js";

describe("black-scholes machinery", () => {
  it("normCdf matches known values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it("normInv inverts normCdf", () => {
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(normCdf(normInv(p))).toBeCloseTo(p, 4);
    }
  });

  it("prices the textbook put (S=100, K=100, sigma=0.2, tau=1, r=0)", () => {
    expect(putPrice(100, 100, 0.2, 1, 0)).toBeCloseTo(7.97, 1);
  });

  it("put price is intrinsic at expiry", () => {
    expect(putPrice(90, 100, 0.2, 0, 0.04)).toBe(10);
    expect(putPrice(110, 100, 0.2, 0, 0.04)).toBe(0);
  });

  it("strikeForPutDelta round-trips: the solved strike has the target delta", () => {
    const S = 60;
    const sigma = 0.25;
    const tau = 36 / 365;
    const r = 0.04;
    const K = strikeForPutDelta(S, sigma, tau, r, 0.25);
    expect(K).toBeLessThan(S); // 0.25-delta put is OTM
    // |put delta| = N(-d1)
    const st = sigma * Math.sqrt(tau);
    const d1 = (Math.log(S / K) + (r + sigma ** 2 / 2) * tau) / st;
    expect(normCdf(-d1)).toBeCloseTo(0.25, 3);
  });
});

function bars(closes: number[]): BtBar[] {
  const start = Date.parse("2024-01-02T00:00:00Z");
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    close: c,
  }));
}

const managed = { key: "d25-managed", targetDelta: 0.25, dteTarget: 36, managed: true };

describe("backtest engine", () => {
  it("flat prices produce only winners (theta does all the work)", () => {
    // Gentle noise so realized vol > 0; price never trends down.
    const closes = Array.from({ length: 300 }, (_, i) => 50 + Math.sin(i / 3) * 0.2);
    const trades = backtestSymbol("TEST", bars(closes), managed);
    expect(trades.length).toBeGreaterThan(3);
    expect(trades.every((t) => t.win)).toBe(true);
  });

  it("a crash produces a losing trade bigger than the typical winner", () => {
    const pre = Array.from({ length: 60 }, (_, i) => 50 + Math.sin(i / 3) * 0.2);
    const crash = Array.from({ length: 40 }, (_, i) => 50 - i * 0.6); // -48% slide
    const post = Array.from({ length: 100 }, () => 26 + Math.random() * 0.01);
    const trades = backtestSymbol("TEST", bars([...pre, ...crash, ...post]), managed);
    const losses = trades.filter((t) => !t.win);
    expect(losses.length).toBeGreaterThan(0);
    const worstLoss = Math.min(...losses.map((t) => t.pnl));
    const wins = trades.filter((t) => t.win);
    if (wins.length > 0) {
      const avgWin = wins.reduce((a, t) => a + t.pnl, 0) / wins.length;
      expect(Math.abs(worstLoss)).toBeGreaterThan(avgWin); // negative skew is structural
    }
  });

  it("stats aggregates correctly", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 50 + Math.sin(i / 3) * 0.2);
    const trades = backtestSymbol("TEST", bars(closes), managed);
    const s = stats(trades, "d25-managed");
    expect(s.trades).toBe(trades.length);
    expect(s.winRate).toBe(1);
    expect(s.totalPnl).toBe(trades.reduce((a, t) => a + t.pnl, 0));
  });
});
