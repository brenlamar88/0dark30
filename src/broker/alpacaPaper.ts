import { env } from "../config.js";
import type { BrokerAdapter, BrokerOrder, BrokerPosition, PlaceLimitRequest } from "./types.js";

const TRADE_BASE = "https://paper-api.alpaca.markets";

function headers(): Record<string, string> {
  return {
    "APCA-API-KEY-ID": env.alpacaKeyId,
    "APCA-API-SECRET-KEY": env.alpacaSecretKey,
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function req(method: string, pathname: string, body?: unknown): Promise<any> {
  const res = await fetch(`${TRADE_BASE}${pathname}`, {
    method,
    headers: headers(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Alpaca paper ${res.status} ${method} ${pathname}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

function toOrder(o: any): BrokerOrder {
  return {
    brokerOrderId: o.id,
    clientOrderId: o.client_order_id ?? null,
    symbol: o.symbol,
    side: o.side,
    qty: Number(o.qty ?? 0),
    limitPrice: o.limit_price !== null && o.limit_price !== undefined ? Number(o.limit_price) : null,
    status: o.status,
    filledQty: Number(o.filled_qty ?? 0),
    filledAvgPrice: o.filled_avg_price !== null && o.filled_avg_price !== undefined ? Number(o.filled_avg_price) : null,
    submittedAt: o.submitted_at ?? o.created_at ?? "",
  };
}

export const alpacaPaper: BrokerAdapter = {
  name: "alpaca-paper",

  async getPositions(): Promise<BrokerPosition[]> {
    const json: any[] = (await req("GET", "/v2/positions")) ?? [];
    return json.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntryPrice: Number(p.avg_entry_price),
      assetClass: p.asset_class === "us_option" ? "option" : "equity",
    }));
  },

  async getOrders(sinceIso: string): Promise<BrokerOrder[]> {
    const json: any[] =
      (await req("GET", `/v2/orders?status=all&after=${encodeURIComponent(sinceIso)}&limit=500`)) ?? [];
    return json.map(toOrder);
  },

  async getOpenOrders(): Promise<BrokerOrder[]> {
    const json: any[] = (await req("GET", "/v2/orders?status=open&limit=500")) ?? [];
    return json.map(toOrder);
  },

  async placeLimit(r: PlaceLimitRequest): Promise<BrokerOrder> {
    // Alpaca options orders support time_in_force "day" only, so the resting
    // profit-target close is re-placed each session by the midday cycle
    // rather than living as one GTC order (Schwab in Phase 3 supports GTC).
    const json = await req("POST", "/v2/orders", {
      symbol: r.symbol,
      qty: String(r.qty),
      side: r.side,
      type: "limit",
      limit_price: String(r.limitPrice),
      time_in_force: "day",
      client_order_id: r.clientOrderId,
    });
    return toOrder(json);
  },

  async cancel(brokerOrderId: string): Promise<void> {
    await req("DELETE", `/v2/orders/${brokerOrderId}`);
  },
};
