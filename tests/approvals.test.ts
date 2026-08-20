import { describe, expect, it } from "vitest";
import { approvalStatus, shortId } from "../src/exec/approvals.js";
import type { Proposal } from "../src/types.js";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "abcd1234-0000-0000-0000-000000000000",
    date: "2026-08-20",
    createdAt: "2026-08-20T12:30:00Z",
    ruleVersion: "wheel-v1",
    strategy: "csp",
    underlying: "XLF",
    sector: "financials",
    occSymbol: "XLF260925P00044000",
    expiry: "2026-09-25",
    strike: 44,
    dte: 36,
    delta: -0.25,
    bid: 0.55,
    ask: 0.6,
    mid: 0.575,
    collateral: 4400,
    premiumAtMid: 57.5,
    rocAnnualizedAtBid: 0.127,
    ivRank: { rank: 55, observations: 120, confident: true },
    checks: [],
    verdict: "proposed",
    ttlHours: 6,
    screenNotes: [],
    llm: null,
    shadowStatus: "open",
    entryMid: 0.575,
    currentMid: 0.575,
    shadowPnl: null,
    closedReason: null,
    ...overrides,
  };
}

const none = { approve: new Set<string>(), reject: new Set<string>() };

describe("approvals", () => {
  it("approves inside the TTL window", () => {
    const d = { approve: new Set([shortId(proposal().id)]), reject: new Set<string>() };
    expect(approvalStatus(proposal(), d, "2026-08-20T15:00:00Z")).toBe("approved");
  });

  it("expires an approval after the TTL", () => {
    const d = { approve: new Set([shortId(proposal().id)]), reject: new Set<string>() };
    expect(approvalStatus(proposal(), d, "2026-08-20T19:00:00Z")).toBe("expired");
  });

  it("rejection wins over approval", () => {
    const sid = shortId(proposal().id);
    const d = { approve: new Set([sid]), reject: new Set([sid]) };
    expect(approvalStatus(proposal(), d, "2026-08-20T13:00:00Z")).toBe("rejected");
  });

  it("stays pending with no decision", () => {
    expect(approvalStatus(proposal(), none, "2026-08-20T13:00:00Z")).toBe("pending");
  });

  it("handles legacy proposals with no createdAt via the date fallback", () => {
    const p = proposal({ createdAt: undefined });
    expect(approvalStatus(p, none, "2026-08-21T13:00:00Z")).toBe("expired");
  });
});
