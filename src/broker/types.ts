/**
 * Broker adapter interface (PLAN.md 2.2): one shape, multiple backends.
 * Phase 2 ships `alpaca-paper`; Phase 3 adds `schwab-live` and `manual`.
 */
export interface BrokerPosition {
  symbol: string; // OCC symbol for options
  qty: number; // negative = short
  avgEntryPrice: number; // per-contract premium (per share, i.e. 0.55 = $55/contract)
  assetClass: "option" | "equity";
}

export interface BrokerOrder {
  brokerOrderId: string;
  clientOrderId: string | null;
  symbol: string;
  side: "sell" | "buy";
  qty: number;
  limitPrice: number | null;
  status: string; // broker-native status: new/accepted/filled/canceled/expired/rejected...
  filledQty: number;
  filledAvgPrice: number | null;
  submittedAt: string;
}

export interface PlaceLimitRequest {
  symbol: string; // OCC symbol
  side: "sell" | "buy";
  qty: number;
  limitPrice: number;
  clientOrderId: string;
}

export interface BrokerAdapter {
  readonly name: string;
  getPositions(): Promise<BrokerPosition[]>;
  getOrders(sinceIso: string): Promise<BrokerOrder[]>;
  getOpenOrders(): Promise<BrokerOrder[]>;
  placeLimit(req: PlaceLimitRequest): Promise<BrokerOrder>;
  cancel(brokerOrderId: string): Promise<void>;
}
