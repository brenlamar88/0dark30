import { daysBetween, loadParams, todayEt } from "../config.js";
import { dailyCloses, optionMids } from "../data/alpaca.js";
import { Journal } from "../journal/journal.js";
import type { Proposal } from "../types.js";

/**
 * Post-close: mark open shadow proposals to market, apply the mechanical
 * management rules (50% profit target, manage at 21 DTE) to the shadow book,
 * and append the daily scoreboard row (SPY close = the null hypothesis).
 * This is what makes the shadow record meaningful rather than a pile of
 * untracked picks - PLAN.md 2.7.
 */
export async function runPostclose(): Promise<void> {
  const params = loadParams();
  const journal = new Journal(params.ruleVersion);
  const today = todayEt();
  await journal.event("cycle.postclose.start", { today });

  const dates = journal.allProposalDates();
  const openByDate: { date: string; proposals: Proposal[] }[] = dates.map((d) => ({
    date: d,
    proposals: journal.loadProposals(d),
  }));
  const open = openByDate.flatMap((x) => x.proposals).filter((p) => p.shadowStatus === "open");

  let mids: Record<string, number> = {};
  if (open.length > 0) {
    try {
      mids = await optionMids(open.map((p) => p.occSymbol));
    } catch (err) {
      await journal.event("data.mark.error", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  let realizedToday = 0;
  for (const { date, proposals } of openByDate) {
    let changed = false;
    for (const p of proposals) {
      if (p.shadowStatus !== "open") continue;
      const mid = mids[p.occSymbol];
      if (mid !== undefined) p.currentMid = mid;
      const dte = daysBetween(today, p.expiry);
      const mark = p.currentMid ?? p.entryMid;
      // Premium received at entry mid; shadow P&L = (entry - current) * 100.
      p.shadowPnl = (p.entryMid - mark) * 100;

      if (mark <= p.entryMid * params.csp.profitTargetFraction) {
        // Models the broker-side GTC buy-to-close at the profit target.
        p.shadowStatus = "closed";
        p.closedReason = "profit-target-50pct";
        p.shadowPnl = p.entryMid * (1 - params.csp.profitTargetFraction) * 100;
      } else if (dte <= params.csp.manageAtDte) {
        p.shadowStatus = "closed";
        p.closedReason = `managed-at-${params.csp.manageAtDte}dte`;
      } else if (dte <= 0) {
        p.shadowStatus = "closed";
        p.closedReason = "expired";
      }
      if (p.shadowStatus === "closed") {
        realizedToday += p.shadowPnl ?? 0;
        changed = true;
        await journal.event("shadow.closed", p);
      }
    }
    if (changed || proposals.some((x) => x.shadowStatus === "open")) {
      await journal.saveProposals(date, proposals);
    }
  }

  const spyCloses = await dailyCloses("SPY", 2);
  const spyClose = spyCloses[spyCloses.length - 1] ?? null;

  const all = openByDate.flatMap((x) => journal.loadProposals(x.date));
  const closed = all.filter((p) => p.shadowStatus === "closed");
  const stillOpen = all.filter((p) => p.shadowStatus === "open");
  const realizedTotal = closed.reduce((a, p) => a + (p.shadowPnl ?? 0), 0);
  const unrealized = stillOpen.reduce((a, p) => a + (p.shadowPnl ?? 0), 0);

  await journal.appendScoreboard({
    date: today,
    spy_close: spyClose,
    shadow_realized_total: realizedTotal,
    shadow_unrealized: unrealized,
    shadow_open_count: stillOpen.length,
    shadow_closed_count: closed.length,
    realized_today: realizedToday,
    rule_version: params.ruleVersion,
  });
  await journal.event("cycle.postclose.done", { spyClose, realizedTotal, unrealized });
  console.log(
    `postclose done: SPY ${spyClose ?? "n/a"}, shadow realized $${realizedTotal.toFixed(0)}, ` +
      `unrealized $${unrealized.toFixed(0)}, open ${stillOpen.length}`,
  );
}
