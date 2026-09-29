import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { briefsDir, daysBetween, executionMode, loadParams, loadUniverse, todayEt } from "../config.js";
import { getFreeze, loadShares } from "../exec/store.js";
import { shortId, telegramSendProposals } from "../exec/approvals.js";
import {
  dailyBars,
  dailyCloses,
  latestPrices,
  optionChain,
  parseOccSymbol,
  putChain,
  realizedVolAnnualized,
} from "../data/alpaca.js";
import { alpacaPaper } from "../broker/alpacaPaper.js";
import { earningsInWindow } from "../data/earnings.js";
import { atmIvProxy, ivRankFor } from "../data/ivrank.js";
import { screenCsp } from "../signals/wheelScreener.js";
import { screenCoveredCall } from "../signals/coveredCall.js";
import { swingEntrySignal } from "../signals/swing.js";
import { writeDashboard } from "../dashboard/render.js";
import { evaluate, shadowState } from "../risk/engine.js";
import { analyzeProposals } from "../llm/analyst.js";
import { renderBrief } from "../brief/render.js";
import { Journal } from "../journal/journal.js";
import type { Candidate, PortfolioState, Proposal, UniverseEntry } from "../types.js";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Paper-mode risk state: caps compute from what the PAPER book actually
 * holds (broker positions, working sell orders, assigned shares), not from
 * the shadow book - otherwise never-approved shadow positions starve the
 * approvable proposals (the cap-state tension found 2026-09-17). Falls back
 * to shadow state on broker error, which is the conservative direction.
 */
async function buildPaperState(
  journal: Journal,
  universe: UniverseEntry[],
  pool: number,
  spyVol: number | null,
): Promise<PortfolioState | null> {
  try {
    const sectorOf = new Map(universe.map((u) => [u.symbol, u.sector]));
    const positions = await alpacaPaper.getPositions();
    const openOrders = await alpacaPaper.getOpenOrders();
    const shares = loadShares();
    const byName: Record<string, number> = {};
    const bySector: Record<string, number> = {};
    let committed = 0;
    const add = (underlying: string, amount: number) => {
      byName[underlying] = (byName[underlying] ?? 0) + amount;
      const sector = sectorOf.get(underlying) ?? "unknown";
      bySector[sector] = (bySector[sector] ?? 0) + amount;
      committed += amount;
    };
    for (const p of positions) {
      if (p.assetClass !== "option" || p.qty >= 0) continue;
      const parsed = parseOccSymbol(p.symbol);
      if (parsed) add(parsed.underlying, parsed.strike * 100 * Math.abs(p.qty));
    }
    for (const o of openOrders) {
      if (o.side !== "sell") continue;
      const parsed = parseOccSymbol(o.symbol);
      if (parsed?.type === "put") add(parsed.underlying, parsed.strike * 100 * o.qty);
    }
    for (const h of shares) add(h.underlying, h.basis * h.shares);
    return {
      poolValue: pool,
      highWaterMark: pool,
      cash: pool - committed,
      openCollateralByName: byName,
      openCollateralBySector: bySector,
      spyRealizedVol20dAnnualized: spyVol,
      reconcilerGreen: getFreeze() === null,
    };
  } catch (err) {
    await journal.event("paper.state.error", { error: String(err) });
    return null;
  }
}

export async function runPremarket(): Promise<void> {
  const params = loadParams();
  const universe = loadUniverse();
  const journal = new Journal(params.ruleVersion);
  const today = todayEt();
  const mode = executionMode();
  await journal.event("cycle.premarket.start", { today, mode, universe: universe.map((u) => u.symbol) });

  // The shadow book (the all-proposals counterfactual, PLAN.md 2.7).
  const openShadow: Proposal[] = journal
    .allProposalDates()
    .filter((d) => d !== today)
    .flatMap((d) => journal.loadProposals(d))
    .filter((p) => p.shadowStatus === "open");
  const shadowOpenNames = new Set(openShadow.map((p) => p.underlying));

  const spyCloses = await dailyCloses("SPY", 21);
  const spyVol = realizedVolAnnualized(spyCloses);
  const prices = await latestPrices(universe.map((u) => u.symbol));

  const expiryGte = addDays(today, params.csp.dteMin);
  const expiryLte = addDays(today, params.csp.dteMax);

  const candidates: Candidate[] = [];
  const screenedOut: { symbol: string; reason: string }[] = [];
  for (const entry of universe) {
    const price = prices[entry.symbol];
    if (price === undefined) {
      await journal.event("data.price.missing", { symbol: entry.symbol });
      screenedOut.push({ symbol: entry.symbol, reason: "no price data this run" });
      continue;
    }
    try {
      const puts = await putChain(entry.symbol, expiryGte, expiryLte);
      const iv = atmIvProxy(puts);
      const ivRank = await ivRankFor(journal, entry.symbol, iv, today, params.screen.ivRankMinObservations);
      const earnings = entry.hasEarnings
        ? await earningsInWindow(entry.symbol, today, addDays(expiryLte, params.screen.earningsBufferDays))
        : false;
      const result = screenCsp({ entry, price, puts, ivRank, earningsInWindow: earnings }, params, today);
      if (result.candidate) candidates.push(result.candidate);
      else if (result.rejection) {
        screenedOut.push({ symbol: entry.symbol, reason: result.rejection });
        await journal.event("screen.rejected", { symbol: entry.symbol, reason: result.rejection });
      }
    } catch (err) {
      await journal.event("data.chain.error", {
        symbol: entry.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
      screenedOut.push({ symbol: entry.symbol, reason: "option-chain fetch failed this run" });
    }
  }

  candidates.sort((a, b) => b.rocAnnualizedAtBid - a.rocAnnualizedAtBid);
  const top = candidates.slice(0, params.maxProposalsPerDay);
  for (const c of candidates.slice(params.maxProposalsPerDay)) {
    screenedOut.push({
      symbol: c.underlying,
      reason: `passed the screen but ranked below the top ${params.maxProposalsPerDay} by annualized return-on-capital`,
    });
  }

  // Covered-call candidates for assigned shares (the wheel's second leg).
  const holdings = mode === "paper" ? loadShares() : [];
  for (const holding of holdings) {
    try {
      const calls = await optionChain(holding.underlying, "call", expiryGte, expiryLte);
      const cc = screenCoveredCall(holding, calls, params, today);
      if (cc.contract) {
        const c = cc.contract;
        candidates.push({
          underlying: holding.underlying,
          sector: universe.find((u) => u.symbol === holding.underlying)?.sector ?? "unknown",
          contract: c,
          dte: daysBetween(today, c.expiry),
          collateral: 0, // covered by the shares, no new cash reserved
          premiumAtBid: c.bid * 100,
          premiumAtMid: c.mid * 100,
          rocAnnualizedAtBid: ((c.bid * 100) / (holding.basis * 100)) * (365 / daysBetween(today, c.expiry)),
          ivRank: { rank: null, observations: 0, confident: false },
          screenNotes: [`covered call against ${holding.shares} shares, basis $${holding.basis.toFixed(2)}`, ...cc.notes],
        });
      } else if (cc.rejection) {
        screenedOut.push({ symbol: `${holding.underlying} (CC)`, reason: cc.rejection });
      }
    } catch (err) {
      await journal.event("data.chain.error", { symbol: holding.underlying, side: "call", error: String(err) });
    }
  }

  // Risk state: paper book in paper mode (fallback shadow), shadow otherwise.
  let state: PortfolioState | null = null;
  let stateSource = "shadow";
  if (mode === "paper") {
    state = await buildPaperState(journal, universe, params.pool.simulatedValueUsd, spyVol);
    if (state) stateSource = "paper-book";
  }
  if (!state) {
    state = shadowState(
      params.pool.simulatedValueUsd,
      openShadow.map((p) => ({ underlying: p.underlying, sector: p.sector, collateral: p.collateral })),
      spyVol,
    );
    state.reconcilerGreen = getFreeze() === null;
  }
  await journal.event("risk.state", { source: stateSource, cash: state.cash });

  const holdingBySymbol = new Map(holdings.map((h) => [h.underlying, h]));
  const proposals: Proposal[] = [];
  for (const c of top.concat(candidates.filter((x) => x.collateral === 0 && holdingBySymbol.has(x.underlying)))) {
    const isCc = c.collateral === 0 && holdingBySymbol.has(c.underlying) && c.contract.type === "call";
    const { checks, verdict } = evaluate(c, state, params);
    const shadowDuplicate = !isCc && shadowOpenNames.has(c.underlying);
    const proposal: Proposal = {
      id: randomUUID(),
      date: today,
      createdAt: new Date().toISOString(),
      ruleVersion: params.ruleVersion,
      strategy: isCc ? "cc" : "csp",
      coveredBasis: isCc ? (holdingBySymbol.get(c.underlying)?.basis ?? null) : null,
      underlying: c.underlying,
      sector: c.sector,
      occSymbol: c.contract.occSymbol,
      expiry: c.contract.expiry,
      strike: c.contract.strike,
      dte: c.dte,
      delta: c.contract.delta,
      bid: c.contract.bid,
      ask: c.contract.ask,
      mid: c.contract.mid,
      collateral: c.collateral,
      premiumAtMid: c.premiumAtMid,
      rocAnnualizedAtBid: c.rocAnnualizedAtBid,
      ivRank: c.ivRank,
      checks,
      verdict,
      ttlHours: params.risk.proposalTtlHours,
      screenNotes: shadowDuplicate
        ? [...c.screenNotes, "shadow book already holds this name - the counterfactual skips it, the paper book may still take it"]
        : c.screenNotes,
      llm: null,
      shadowStatus: verdict === "proposed" && !shadowDuplicate && !isCc ? "open" : "blocked",
      entryMid: c.contract.mid,
      currentMid: c.contract.mid,
      shadowPnl: null,
      closedReason: shadowDuplicate ? "shadow-duplicate" : null,
    };
    if (verdict === "proposed" && !isCc) {
      state.cash -= c.collateral;
      state.openCollateralByName[c.underlying] = (state.openCollateralByName[c.underlying] ?? 0) + c.collateral;
      state.openCollateralBySector[c.sector] = (state.openCollateralBySector[c.sector] ?? 0) + c.collateral;
    }
    proposals.push(proposal);
  }

  // Swing module (swing-v1): shadow-only signals, PLAN.md 2.4. No order path exists.
  let swingToday: string[] = [];
  if (params.swing) {
    const swing = journal.loadSwingPositions();
    const openSwing = new Set(swing.filter((s) => s.status === "open").map((s) => s.symbol));
    for (const entry of universe) {
      if (openSwing.has(entry.symbol)) continue;
      try {
        const bars = await dailyBars(entry.symbol, params.swing.smaLong + params.swing.volProxyPeriod + 5);
        const sig = swingEntrySignal(entry.symbol, bars, params.swing);
        if (sig) {
          swing.push(sig);
          swingToday.push(entry.symbol);
          await journal.event("swing.entry", sig);
        }
      } catch {
        /* bar fetch failure for one symbol should not kill the cycle */
      }
    }
    if (swingToday.length > 0) journal.saveSwingPositions(swing);
  }

  const llm = await analyzeProposals(proposals.filter((p) => p.verdict === "proposed"));
  if (llm) {
    for (const p of proposals) {
      const a = llm.byId.get(p.id);
      if (a) p.llm = a;
    }
  } else {
    await journal.event("llm.analyst.degraded", { reason: "no key, no proposals, or API error" });
  }

  await journal.saveProposals(today, proposals);
  for (const p of proposals) await journal.event("proposal." + p.verdict, p);

  if (mode === "paper") {
    const proposed = proposals.filter((p) => p.verdict === "proposed");
    await telegramSendProposals(proposed);
    if (proposed.length > 0) {
      console.log(
        "approval ids: " + proposed.map((p) => `${p.underlying}=${shortId(p.id)}`).join(", ") +
          ` (approve via approvals/${today}.json or Telegram)`,
      );
    }
  }

  const html = renderBrief(today, proposals, {
    marketNote: llm?.marketNote ?? null,
    spyRealizedVol: spyVol,
    ruleVersion: params.ruleVersion,
    openShadowCount: openShadow.length,
    llmDegraded: llm === null,
    screenedOut,
    mode,
    swing: params.swing
      ? {
          ruleVersion: params.swing.ruleVersion,
          entriesToday: swingToday,
          open: journal.loadSwingPositions().filter((s) => s.status === "open"),
        }
      : undefined,
  });
  mkdirSync(briefsDir, { recursive: true });
  const briefPath = path.join(briefsDir, `${today}.html`);
  writeFileSync(briefPath, html);
  writeDashboard(journal, params);
  await journal.event("cycle.premarket.done", {
    proposed: proposals.filter((p) => p.verdict === "proposed").length,
    blocked: proposals.filter((p) => p.verdict === "blocked").length,
    swingEntries: swingToday,
    brief: briefPath,
  });
  console.log(
    `premarket done: ${proposals.filter((p) => p.verdict === "proposed").length} proposed, ` +
      `${proposals.filter((p) => p.verdict === "blocked").length} blocked, ` +
      `${swingToday.length} swing entries -> ${briefPath}`,
  );
}

export { addDays, daysBetween };
