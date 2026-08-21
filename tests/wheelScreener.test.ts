import { describe, expect, it } from "vitest";
import { screenCsp } from "../src/signals/wheelScreener.js";

const screen = (...args: Parameters<typeof screenCsp>) => screenCsp(...args).candidate;
import { TODAY, params, put, xlf } from "./fixtures.js";
import type { IvRank } from "../src/types.js";

const confidentIv: IvRank = { rank: 55, observations: 120, confident: true };
const bootstrapIv: IvRank = { rank: 10, observations: 5, confident: false };

function input(overrides: Partial<Parameters<typeof screenCsp>[0]> = {}) {
  return {
    entry: xlf,
    price: 45,
    puts: [put({})],
    ivRank: confidentIv,
    earningsInWindow: false as boolean | null,
    ...overrides,
  };
}

describe("screenCsp", () => {
  it("selects a contract inside the delta and DTE bands", () => {
    const c = screen(input(), params, TODAY);
    expect(c).not.toBeNull();
    expect(c!.contract.strike).toBe(44);
    expect(c!.collateral).toBe(4400);
    expect(c!.rocAnnualizedAtBid).toBeGreaterThan(0.1);
  });

  it("rejects wide spreads", () => {
    const c = screen(input({ puts: [put({ bid: 0.4, ask: 0.8, mid: 0.6 })] }), params, TODAY);
    expect(c).toBeNull();
  });

  it("rejects delta outside band", () => {
    const c = screen(input({ puts: [put({ delta: -0.45 })] }), params, TODAY);
    expect(c).toBeNull();
  });

  it("rejects DTE outside window", () => {
    const c = screen(input({ puts: [put({ expiry: "2026-08-29" })] }), params, TODAY);
    expect(c).toBeNull();
  });

  it("rejects thin open interest", () => {
    const c = screen(input({ puts: [put({ openInterest: 40 })] }), params, TODAY);
    expect(c).toBeNull();
  });

  it("rejects collateral above the per-position cap", () => {
    // 12% of 50k = $6k cap; strike 70 -> $7k collateral
    const c = screen(
      input({ puts: [put({ strike: 70, occSymbol: "XLF260925P00070000" })] }),
      params,
      TODAY,
    );
    expect(c).toBeNull();
  });

  it("enforces IV rank once history is confident", () => {
    const c = screen(
      input({ ivRank: { rank: 12, observations: 120, confident: true } }),
      params,
      TODAY,
    );
    expect(c).toBeNull();
  });

  it("does not enforce IV rank while bootstrapping, but tags the candidate", () => {
    const c = screen(input({ ivRank: bootstrapIv }), params, TODAY);
    expect(c).not.toBeNull();
    expect(c!.screenNotes.some((n) => n.includes("low confidence"))).toBe(true);
  });

  it("blocks hasEarnings symbols when the calendar is unknown", () => {
    const c = screen(
      input({ entry: { symbol: "XYZ", sector: "tech", hasEarnings: true }, earningsInWindow: null }),
      params,
      TODAY,
    );
    expect(c).toBeNull();
  });

  it("blocks earnings inside the expiry window", () => {
    const c = screen(
      input({ entry: { symbol: "XYZ", sector: "tech", hasEarnings: true }, earningsInWindow: true }),
      params,
      TODAY,
    );
    expect(c).toBeNull();
  });

  it("explains rejections in plain language", () => {
    const capped = screenCsp(
      input({ puts: [put({ strike: 70, occSymbol: "XLF260925P00070000" })] }),
      params,
      TODAY,
    );
    expect(capped.rejection).toContain("collateral");
    const cheapVol = screenCsp(input({ ivRank: { rank: 12, observations: 120, confident: true } }), params, TODAY);
    expect(cheapVol.rejection).toContain("IV rank 12");
    const ok = screenCsp(input(), params, TODAY);
    expect(ok.rejection).toBeNull();
  });

  it("picks the highest annualized RoC among eligible contracts", () => {
    const richer = put({
      occSymbol: "XLF260925P00043000",
      strike: 43,
      bid: 0.7,
      ask: 0.74,
      mid: 0.72,
      delta: -0.28,
    });
    const c = screen(input({ puts: [put({}), richer] }), params, TODAY);
    expect(c!.contract.strike).toBe(43);
  });
});
