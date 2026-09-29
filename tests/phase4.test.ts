import { describe, expect, it } from "vitest";
import { swingEntrySignal, swingExitCheck, type SwingBar } from "../src/signals/swing.js";
import { screenCoveredCall } from "../src/signals/coveredCall.js";
import { params, put } from "./fixtures.js";

const swingParams = {
  ruleVersion: "swing-v1-test",
  shadowOnly: true,
  smaLong: 100,
  smaShort: 20,
  volProxyPeriod: 14,
  stopVolMult: 2,
  targetVolMult: 3,
  timeStopSessions: 20,
  notionalPerTradeUsd: 5000,
};

function bars(closes: number[]): SwingBar[] {
  const start = Date.parse("2026-01-02T00:00:00Z");
  return closes.map((c, i) => ({
    date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
    close: c,
  }));
}

describe("swing entry signal", () => {
  it("fires on uptrend + pullback", () => {
    // 120 sessions rising 40 -> 52, then a 3-session dip below the 20d SMA.
    const closes = Array.from({ length: 117 }, (_, i) => 40 + i * 0.1);
    closes.push(51, 50.2, 49.6);
    const sig = swingEntrySignal("TEST", bars(closes), swingParams);
    expect(sig).not.toBeNull();
    expect(sig!.stop).toBeLessThan(sig!.entryPrice);
    expect(sig!.target).toBeGreaterThan(sig!.entryPrice);
    expect(sig!.shares).toBe(Math.floor(5000 / 49.6));
  });

  it("does not fire in a downtrend even on a pullback", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 60 - i * 0.1);
    expect(swingEntrySignal("TEST", bars(closes), swingParams)).toBeNull();
  });

  it("does not fire without a pullback (close above short SMA)", () => {
    const closes = Array.from({ length: 120 }, (_, i) => 40 + i * 0.1);
    expect(swingEntrySignal("TEST", bars(closes), swingParams)).toBeNull();
  });

  it("needs enough history", () => {
    expect(swingEntrySignal("TEST", bars([50, 49, 48]), swingParams)).toBeNull();
  });
});

describe("swing exits", () => {
  const pos: import("../src/signals/swing.js").SwingPosition = {
    symbol: "TEST",
    ruleVersion: "swing-v1-test",
    entryDate: "2026-05-01",
    entryPrice: 50,
    shares: 100,
    stop: 48,
    target: 53,
    lastMarkedDate: null,
    status: "open",
    exitDate: null,
    exitPrice: null,
    pnl: null,
    exitReason: null,
    sessionsHeld: 0,
  };

  it("stops out at the stop", () => {
    const next = swingExitCheck(pos, "2026-05-05", 47.5, swingParams);
    expect(next.status).toBe("closed");
    expect(next.exitReason).toBe("stop");
    expect(next.pnl).toBe(-250);
  });

  it("takes the target", () => {
    const next = swingExitCheck(pos, "2026-05-05", 53.4, swingParams);
    expect(next.exitReason).toBe("target");
    expect(next.pnl).toBe(340);
  });

  it("time-stops after the session budget", () => {
    let cur = pos;
    for (let i = 0; i < 20; i++) cur = swingExitCheck(cur, `2026-06-${String(i + 1).padStart(2, "0")}`, 50.5, swingParams);
    expect(cur.status).toBe("closed");
    expect(cur.exitReason).toBe("time-stop");
  });
});

describe("covered-call screen", () => {
  const holding = { underlying: "XLF", shares: 100, basis: 43.45, acquiredAt: "2026-09-01", viaOcc: "XLF260925P00044000" };
  const call = (overrides = {}) =>
    put({ occSymbol: "XLF261030C00045000", type: "call" as const, strike: 45, expiry: "2026-10-30", delta: 0.25, ...overrides });

  it("picks a qualifying call above basis", () => {
    const r = screenCoveredCall(holding, [call()], params, "2026-09-24");
    expect(r.contract).not.toBeNull();
    expect(r.contract!.strike).toBeGreaterThanOrEqual(holding.basis);
    expect(r.notes).toHaveLength(0);
  });

  it("annotates loudly when only below-basis strikes qualify", () => {
    const r = screenCoveredCall(
      holding,
      [call({ occSymbol: "XLF261030C00042000", strike: 42 })],
      params,
      "2026-09-24",
    );
    expect(r.contract).not.toBeNull();
    expect(r.notes[0]).toContain("NO STRIKE ABOVE BASIS");
  });

  it("rejects when nothing passes the screen", () => {
    const r = screenCoveredCall(holding, [call({ delta: 0.6 })], params, "2026-09-24");
    expect(r.contract).toBeNull();
    expect(r.rejection).toContain("no call");
  });
});
