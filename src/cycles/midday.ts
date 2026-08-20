import { randomUUID } from "node:crypto";
import { daysBetween, executionMode, loadParams, todayEt } from "../config.js";
import { optionMids } from "../data/alpaca.js";
import { alpacaPaper } from "../broker/alpacaPaper.js";
import type { BrokerAdapter } from "../broker/types.js";
import { Journal } from "../journal/journal.js";
import { loadOrders, saveOrders, getFreeze, setFreeze, type OrderRecord } from "../exec/store.js";
import { reconcile } from "../exec/reconciler.js";
import {
  approvalStatus,
  mergeDecisions,
  readApprovalFile,
  telegramNotify,
  telegramPollDecisions,
} from "../exec/approvals.js";
import type { Proposal } from "../types.js";

/** Sync broker order state into our records; journal every transition. */
export async function syncOrders(broker: BrokerAdapter, journal: Journal): Promise<OrderRecord[]> {
  const orders = loadOrders();
  const pending = orders.filter((o) => o.status === "staged" || o.status === "working");
  if (pending.length > 0) {
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const brokerOrders = await broker.getOrders(since);
    for (const rec of pending) {
      const bo = brokerOrders.find(
        (b) => b.brokerOrderId === rec.brokerOrderId || b.clientOrderId === rec.id,
      );
      if (!bo) continue;
      rec.brokerOrderId = bo.brokerOrderId;
      rec.filledQty = bo.filledQty;
      rec.filledAvgPrice = bo.filledAvgPrice;
      const map: Record<string, OrderRecord["status"]> = {
        filled: "filled",
        canceled: "cancelled",
        expired: "expired",
        rejected: "rejected",
        done_for_day: "expired",
      };
      const next = map[bo.status] ?? (bo.status === "new" || bo.status === "accepted" || bo.status === "partially_filled" ? "working" : rec.status);
      if (next !== rec.status) {
        rec.status = next;
        rec.updatedAt = new Date().toISOString();
        await journal.event("order." + next, rec);
      }
    }
    saveOrders(orders);
  }
  return orders;
}

export async function runMidday(): Promise<void> {
  const mode = executionMode();
  const params = loadParams();
  const journal = new Journal(params.ruleVersion);
  if (mode !== "paper") {
    console.log("midday: shadow mode - nothing to do (Phase 2 is dark; set EXECUTION_MODE=paper to enable).");
    return;
  }
  const broker = alpacaPaper;
  const today = todayEt();
  const now = new Date().toISOString();
  await journal.event("cycle.midday.start", { today, mode });

  // 1. Sync order state, then reconcile - broker is truth (PLAN.md 2.0 #5).
  let orders = await syncOrders(broker, journal);
  const positions = await broker.getPositions();
  const rec = reconcile(positions, orders);
  if (!rec.green && !getFreeze()) {
    setFreeze({ reason: "reconciler divergence", at: now, detail: rec.divergences });
    await journal.event("freeze.set", rec.divergences);
    await telegramNotify(`0dark30 FROZEN: ${rec.divergences.join("; ")}`);
  }
  const frozen = getFreeze() !== null;

  // 2. Process approvals for recent proposals (TTL bounds how far back matters).
  const dates = journal.allProposalDates().slice(-3);
  const fileDecisions = dates.map((d) => readApprovalFile(d)).reduce(mergeDecisions, {
    approve: new Set<string>(),
    reject: new Set<string>(),
  });
  const decisions = mergeDecisions(fileDecisions, await telegramPollDecisions());

  for (const date of dates) {
    const proposals = journal.loadProposals(date);
    for (const p of proposals) {
      if (p.verdict !== "proposed") continue;
      if (orders.some((o) => o.proposalId === p.id)) continue; // already acted on
      const status = approvalStatus(p, decisions, now);
      if (status === "pending") continue;
      if (status === "rejected" || status === "expired") {
        await journal.event(`approval.${status}`, { proposalId: p.id, date });
        continue;
      }
      // status === "approved"
      if (frozen) {
        await journal.event("approval.blocked-frozen", { proposalId: p.id });
        continue;
      }
      await stageEntry(broker, journal, p, orders);
    }
  }

  // 3. Manage open short positions: re-place the day-limit profit-target close
  //    (Alpaca options have no GTC), and close outright at the 21-DTE mark.
  //    Management continues even under a freeze - a freeze blocks NEW risk only.
  orders = loadOrders();
  const openOrders = await broker.getOpenOrders();
  const shortPuts = positions.filter((p) => p.assetClass === "option" && p.qty < 0);
  const mids = shortPuts.length
    ? await optionMids(shortPuts.map((p) => p.symbol)).catch(() => ({}) as Record<string, number>)
    : {};
  for (const pos of shortPuts) {
    const hasClose = openOrders.some((o) => o.symbol === pos.symbol && o.side === "buy");
    if (hasClose) continue;
    const expiry = occExpiry(pos.symbol);
    const dte = expiry ? daysBetween(today, expiry) : null;
    const entry = pos.avgEntryPrice;
    const manage = dte !== null && dte <= params.csp.manageAtDte;
    const target = manage
      ? (mids[pos.symbol] ?? entry) // marketable: close at current mid
      : round2(entry * params.csp.profitTargetFraction);
    const record: OrderRecord = {
      id: randomUUID(),
      proposalId: findEntryOrder(orders, pos.symbol)?.proposalId ?? "unknown",
      intent: manage ? "close-manage-dte" : "close-profit-target",
      occSymbol: pos.symbol,
      side: "buy",
      qty: Math.abs(pos.qty),
      limitPrice: target,
      status: "staged",
      brokerOrderId: null,
      filledQty: 0,
      filledAvgPrice: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const bo = await broker.placeLimit({
        symbol: pos.symbol,
        side: "buy",
        qty: record.qty,
        limitPrice: target,
        clientOrderId: record.id,
      });
      record.brokerOrderId = bo.brokerOrderId;
      record.status = "working";
      await journal.event("order.working", record);
    } catch (err) {
      record.status = "failed";
      await journal.event("order.failed", { record, error: String(err) });
    }
    orders.push(record);
    saveOrders(orders);
  }

  await journal.event("cycle.midday.done", {
    frozen,
    positions: positions.length,
    approvals: { approved: decisions.approve.size, rejected: decisions.reject.size },
  });
  console.log(`midday done: ${positions.length} positions, frozen=${frozen}`);
}

async function stageEntry(
  broker: BrokerAdapter,
  journal: Journal,
  p: Proposal,
  orders: OrderRecord[],
): Promise<void> {
  const now = new Date().toISOString();
  // Re-quote before staging: an approval is for the premium the human saw.
  // If the premium has decayed more than 30% since the proposal, do not chase.
  let currentMid = p.mid;
  try {
    const mids = await optionMids([p.occSymbol]);
    if (mids[p.occSymbol] !== undefined) currentMid = mids[p.occSymbol]!;
  } catch {
    /* quote unavailable: fall back to proposal mid as the limit (conservative for a sell) */
  }
  if (currentMid < p.mid * 0.7) {
    await journal.event("approval.skipped-premium-decayed", {
      proposalId: p.id,
      proposalMid: p.mid,
      currentMid,
    });
    return;
  }
  const record: OrderRecord = {
    id: randomUUID(),
    proposalId: p.id,
    intent: "open-csp",
    occSymbol: p.occSymbol,
    side: "sell",
    qty: 1,
    limitPrice: round2(currentMid),
    status: "staged",
    brokerOrderId: null,
    filledQty: 0,
    filledAvgPrice: null,
    createdAt: now,
    updatedAt: now,
  };
  try {
    const bo = await broker.placeLimit({
      symbol: p.occSymbol,
      side: "sell",
      qty: 1,
      limitPrice: record.limitPrice,
      clientOrderId: record.id,
    });
    record.brokerOrderId = bo.brokerOrderId;
    record.status = "working";
    await journal.event("order.working", record);
    await telegramNotify(
      `0dark30: staged sell ${p.underlying} ${p.expiry} $${p.strike}p limit ${record.limitPrice} (day order)`,
    );
  } catch (err) {
    record.status = "failed";
    await journal.event("order.failed", { record, error: String(err) });
  }
  orders.push(record);
  saveOrders(orders);
}

function findEntryOrder(orders: OrderRecord[], occSymbol: string): OrderRecord | undefined {
  return orders.find((o) => o.occSymbol === occSymbol && o.intent === "open-csp" && o.status === "filled");
}

function occExpiry(occ: string): string | null {
  const m = occ.match(/^[A-Z.]{1,6}(\d{6})[CP]\d{8}$/);
  if (!m) return null;
  return `20${m[1]!.slice(0, 2)}-${m[1]!.slice(2, 4)}-${m[1]!.slice(4, 6)}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
