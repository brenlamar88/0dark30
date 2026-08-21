import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { briefsDir, daysBetween, executionMode, loadParams, loadUniverse, todayEt } from "../config.js";
import { getFreeze } from "../exec/store.js";
import { shortId, telegramSendProposals } from "../exec/approvals.js";
import { dailyCloses, latestPrices, putChain, realizedVolAnnualized } from "../data/alpaca.js";
import { earningsInWindow } from "../data/earnings.js";
import { atmIvProxy, ivRankFor } from "../data/ivrank.js";
import { screenCsp } from "../signals/wheelScreener.js";
import { writeDashboard } from "../dashboard/render.js";
import { evaluate, shadowState } from "../risk/engine.js";
import { analyzeProposals } from "../llm/analyst.js";
import { renderBrief } from "../brief/render.js";
import { Journal } from "../journal/journal.js";
import type { Candidate, Proposal } from "../types.js";

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function runPremarket(): Promise<void> {
  const params = loadParams();
  const universe = loadUniverse();
  const journal = new Journal(params.ruleVersion);
  const today = todayEt();
  await journal.event("cycle.premarket.start", { today, universe: universe.map((u) => u.symbol) });

  // Open shadow proposals from prior days stand in as positions for the risk caps.
  const openShadow: Proposal[] = journal
    .allProposalDates()
    .filter((d) => d !== today)
    .flatMap((d) => journal.loadProposals(d))
    .filter((p) => p.shadowStatus === "open");

  const spyCloses = await dailyCloses("SPY", 21);
  const spyVol = realizedVolAnnualized(spyCloses);
  const prices = await latestPrices(universe.map((u) => u.symbol));

  const expiryGte = addDays(today, params.csp.dteMin);
  const expiryLte = addDays(today, params.csp.dteMax);

  const candidates: Candidate[] = [];
  for (const entry of universe) {
    const price = prices[entry.symbol];
    if (price === undefined) {
      await journal.event("data.price.missing", { symbol: entry.symbol });
      continue;
    }
    try {
      const puts = await putChain(entry.symbol, expiryGte, expiryLte);
      const iv = atmIvProxy(puts);
      const ivRank = await ivRankFor(journal, entry.symbol, iv, today, params.screen.ivRankMinObservations);
      const earnings = entry.hasEarnings
        ? await earningsInWindow(entry.symbol, today, addDays(expiryLte, params.screen.earningsBufferDays))
        : false;
      const candidate = screenCsp({ entry, price, puts, ivRank, earningsInWindow: earnings }, params, today);
      if (candidate) candidates.push(candidate);
    } catch (err) {
      await journal.event("data.chain.error", {
        symbol: entry.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  candidates.sort((a, b) => b.rocAnnualizedAtBid - a.rocAnnualizedAtBid);
  const top = candidates.slice(0, params.maxProposalsPerDay);

  // Risk engine runs sequentially so each accepted proposal counts against the
  // caps for the next one - same as live sizing would.
  const state = shadowState(
    params.pool.simulatedValueUsd,
    openShadow.map((p) => ({ underlying: p.underlying, sector: p.sector, collateral: p.collateral })),
    spyVol,
  );
  // In paper mode the reconciler's verdict carries into the risk engine: an
  // unresolved divergence blocks new proposals at the source (PLAN.md 2.5 #1).
  state.reconcilerGreen = getFreeze() === null;
  const proposals: Proposal[] = [];
  for (const c of top) {
    const { checks, verdict } = evaluate(c, state, params);
    const proposal: Proposal = {
      id: randomUUID(),
      date: today,
      createdAt: new Date().toISOString(),
      ruleVersion: params.ruleVersion,
      strategy: "csp",
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
      screenNotes: c.screenNotes,
      llm: null,
      shadowStatus: verdict === "proposed" ? "open" : "blocked",
      entryMid: c.contract.mid,
      currentMid: c.contract.mid,
      shadowPnl: null,
      closedReason: null,
    };
    if (verdict === "proposed") {
      state.cash -= c.collateral;
      state.openCollateralByName[c.underlying] = (state.openCollateralByName[c.underlying] ?? 0) + c.collateral;
      state.openCollateralBySector[c.sector] = (state.openCollateralBySector[c.sector] ?? 0) + c.collateral;
    }
    proposals.push(proposal);
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

  if (executionMode() === "paper") {
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
  });
  mkdirSync(briefsDir, { recursive: true });
  const briefPath = path.join(briefsDir, `${today}.html`);
  writeFileSync(briefPath, html);
  // Refresh the dashboard here too - otherwise the front page shows
  // yesterday's state until postclose and a working morning looks like a
  // silent failure.
  writeDashboard(journal, params);
  await journal.event("cycle.premarket.done", {
    proposed: proposals.filter((p) => p.verdict === "proposed").length,
    blocked: proposals.filter((p) => p.verdict === "blocked").length,
    brief: briefPath,
  });
  console.log(
    `premarket done: ${proposals.filter((p) => p.verdict === "proposed").length} proposed, ` +
      `${proposals.filter((p) => p.verdict === "blocked").length} blocked -> ${briefPath}`,
  );
}

export { addDays, daysBetween };
