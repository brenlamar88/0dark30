import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";

/**
 * Order lifecycle (PLAN.md 2.6):
 * proposed -> (approved|rejected|expired) -> staged -> working -> (filled|cancelled) -> managed -> closed
 * Proposals live in the journal; this store tracks everything from approval on.
 */
export type OrderStatus = "staged" | "working" | "filled" | "cancelled" | "expired" | "rejected" | "failed";

export interface OrderRecord {
  id: string; // our id (client_order_id at the broker)
  proposalId: string;
  intent: "open-csp" | "close-profit-target" | "close-manage-dte";
  occSymbol: string;
  side: "sell" | "buy";
  qty: number;
  limitPrice: number;
  status: OrderStatus;
  brokerOrderId: string | null;
  filledQty: number;
  filledAvgPrice: number | null;
  createdAt: string;
  updatedAt: string;
}

const ordersFile = path.join(dataDir, "orders", "orders.json");
const freezeFile = path.join(dataDir, "state", "freeze.json");

export function loadOrders(): OrderRecord[] {
  if (!existsSync(ordersFile)) return [];
  return JSON.parse(readFileSync(ordersFile, "utf8"));
}

export function saveOrders(orders: OrderRecord[]): void {
  mkdirSync(path.dirname(ordersFile), { recursive: true });
  writeFileSync(ordersFile, JSON.stringify(orders, null, 2));
}

export interface FreezeState {
  reason: string;
  at: string;
  detail?: unknown;
}

export function getFreeze(): FreezeState | null {
  if (!existsSync(freezeFile)) return null;
  return JSON.parse(readFileSync(freezeFile, "utf8"));
}

export function setFreeze(state: FreezeState): void {
  mkdirSync(path.dirname(freezeFile), { recursive: true });
  writeFileSync(freezeFile, JSON.stringify(state, null, 2));
}

/** Clearing a freeze is a deliberate act: requires a written reason, which the caller must journal. */
export function clearFreeze(): void {
  if (existsSync(freezeFile)) rmSync(freezeFile);
}
