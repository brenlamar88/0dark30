import { env } from "../config.js";
import type { OptionQuote } from "../types.js";

const DATA_BASE = "https://data.alpaca.markets";

function headers(): Record<string, string> {
  if (!env.alpacaKeyId || !env.alpacaSecretKey) {
    throw new Error(
      "ALPACA_KEY_ID / ALPACA_SECRET_KEY are not set. Create a free Alpaca paper account and put the keys in .env - see docs/PHASE1.md.",
    );
  }
  return {
    "APCA-API-KEY-ID": env.alpacaKeyId,
    "APCA-API-SECRET-KEY": env.alpacaSecretKey,
    accept: "application/json",
  };
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status} for ${url.split("?")[0]}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function latestPrices(symbols: string[]): Promise<Record<string, number>> {
  const url = `${DATA_BASE}/v2/stocks/trades/latest?symbols=${symbols.join(",")}&feed=iex`;
  const json = await getJson(url);
  const out: Record<string, number> = {};
  for (const [sym, trade] of Object.entries<any>(json.trades ?? {})) {
    if (trade && typeof trade.p === "number") out[sym] = trade.p;
  }
  return out;
}

export async function dailyCloses(symbol: string, days: number): Promise<number[]> {
  const start = new Date(Date.now() - (days + 10) * 86_400_000).toISOString().slice(0, 10);
  const url =
    `${DATA_BASE}/v2/stocks/bars?symbols=${symbol}&timeframe=1Day&start=${start}` +
    `&limit=${days + 10}&adjustment=split&feed=iex&sort=asc`;
  const json = await getJson(url);
  const bars: any[] = json.bars?.[symbol] ?? [];
  return bars.map((b) => b.c).filter((c): c is number => typeof c === "number").slice(-days);
}

/** OCC option symbol: AAPL  241220P00230000 -> underlying, yymmdd, C/P, strike*1000 */
export function parseOccSymbol(occ: string): { underlying: string; expiry: string; type: "put" | "call"; strike: number } | null {
  const m = occ.match(/^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  const [, underlying, yymmdd, cp, strikeRaw] = m;
  const expiry = `20${yymmdd!.slice(0, 2)}-${yymmdd!.slice(2, 4)}-${yymmdd!.slice(4, 6)}`;
  return {
    underlying: underlying!,
    expiry,
    type: cp === "P" ? "put" : "call",
    strike: Number(strikeRaw) / 1000,
  };
}

function snapshotToQuote(occ: string, snap: any): OptionQuote | null {
  const parsed = parseOccSymbol(occ);
  if (!parsed) return null;
  const bid = snap?.latestQuote?.bp ?? 0;
  const ask = snap?.latestQuote?.ap ?? 0;
  if (!(bid > 0) || !(ask > 0)) return null;
  return {
    occSymbol: occ,
    underlying: parsed.underlying,
    type: parsed.type,
    strike: parsed.strike,
    expiry: parsed.expiry,
    bid,
    ask,
    mid: (bid + ask) / 2,
    delta: typeof snap?.greeks?.delta === "number" ? snap.greeks.delta : null,
    iv: typeof snap?.impliedVolatility === "number" ? snap.impliedVolatility : null,
    openInterest: typeof snap?.openInterest === "number" ? snap.openInterest : null,
  };
}

/** Put chain for one underlying within an expiry window. Uses the free indicative feed. */
export async function putChain(
  underlying: string,
  expiryGte: string,
  expiryLte: string,
): Promise<OptionQuote[]> {
  const quotes: OptionQuote[] = [];
  let pageToken: string | null = null;
  do {
    let url =
      `${DATA_BASE}/v1beta1/options/snapshots/${underlying}?feed=indicative&type=put` +
      `&expiration_date_gte=${expiryGte}&expiration_date_lte=${expiryLte}&limit=1000`;
    if (pageToken) url += `&page_token=${encodeURIComponent(pageToken)}`;
    const json = await getJson(url);
    for (const [occ, snap] of Object.entries<any>(json.snapshots ?? {})) {
      const q = snapshotToQuote(occ, snap);
      if (q) quotes.push(q);
    }
    pageToken = json.next_page_token ?? null;
  } while (pageToken);
  return quotes;
}

/** Current snapshots for specific contracts (used by postclose to mark shadow proposals). */
export async function optionMids(occSymbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const byUnderlying = new Map<string, string[]>();
  for (const occ of occSymbols) {
    const parsed = parseOccSymbol(occ);
    if (!parsed) continue;
    const list = byUnderlying.get(parsed.underlying) ?? [];
    list.push(occ);
    byUnderlying.set(parsed.underlying, list);
  }
  for (const [underlying, occs] of byUnderlying) {
    const expiries = occs.map((o) => parseOccSymbol(o)!.expiry).sort();
    const chain = await putChain(underlying, expiries[0]!, expiries[expiries.length - 1]!);
    for (const q of chain) {
      if (occs.includes(q.occSymbol)) out[q.occSymbol] = q.mid;
    }
  }
  return out;
}

export function realizedVolAnnualized(closes: number[]): number | null {
  if (closes.length < 15) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    rets.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}
