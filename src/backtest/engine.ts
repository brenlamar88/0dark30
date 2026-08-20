import { putPrice, realizedVolAt, strikeForPutDelta } from "./bs.js";

/**
 * Model-based CSP backtest: replays real daily closes and runs the wheel-v1
 * entry/management rules against SYNTHETIC premiums (Black-Scholes on
 * trailing realized vol). Deterministic and pure - no I/O.
 *
 * Known biases, stated up front (also printed on the report page):
 * - Premiums are modeled, not quoted: real IV usually exceeds realized vol,
 *   so modeled premiums tend to UNDERSTATE what a seller actually collects.
 * - Fills at model mid, zero spread/slippage/commissions - flatters results.
 * - No IV-rank gate (it needs an implied-vol history the model lacks), no
 *   sector caps (single-contract per symbol only), no assignment mechanics.
 */

export interface BtBar {
  date: string;
  close: number;
}

export interface BtVariant {
  key: string;
  targetDelta: number; // absolute
  dteTarget: number; // calendar days
  managed: boolean; // true: 50% profit target + 21-DTE exit; false: hold to expiry
}

export interface BtTrade {
  symbol: string;
  variant: string;
  entryDate: string;
  exitDate: string;
  strike: number;
  premium: number; // per share
  exitCost: number; // per share
  pnl: number; // dollars per contract (x100)
  reason: "profit-target" | "dte-exit" | "expiry";
  win: boolean;
  collateral: number;
}

const VOL_WINDOW = 21;
const RISK_FREE = 0.04;
const PROFIT_TARGET = 0.5;
const MANAGE_DTE = 21;

function calendarDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function backtestSymbol(symbol: string, bars: BtBar[], variant: BtVariant): BtTrade[] {
  const closes = bars.map((b) => b.close);
  const trades: BtTrade[] = [];
  let i = VOL_WINDOW + 1;

  while (i < bars.length - 2) {
    const sigma = realizedVolAt(closes, i, VOL_WINDOW);
    if (sigma === null || sigma <= 0) {
      i++;
      continue;
    }
    const S = closes[i]!;
    const entryDate = bars[i]!.date;
    const tau = variant.dteTarget / 365;
    const rawStrike = strikeForPutDelta(S, sigma, tau, RISK_FREE, variant.targetDelta);
    const strike = Math.round(rawStrike * 2) / 2; // half-dollar strike grid
    const premium = putPrice(S, strike, sigma, tau, RISK_FREE);
    if (premium < 0.05) {
      i++;
      continue;
    }

    // Walk forward until an exit rule fires.
    let exitIdx = -1;
    let exitCost = 0;
    let reason: BtTrade["reason"] = "expiry";
    for (let j = i + 1; j < bars.length; j++) {
      const daysHeld = calendarDays(entryDate, bars[j]!.date);
      const dteLeft = variant.dteTarget - daysHeld;
      const sig = realizedVolAt(closes, j, VOL_WINDOW) ?? sigma;
      const mark = putPrice(closes[j]!, strike, sig, Math.max(dteLeft, 0) / 365, RISK_FREE);
      if (dteLeft <= 0) {
        exitIdx = j;
        exitCost = Math.max(0, strike - closes[j]!); // intrinsic at expiry
        reason = "expiry";
        break;
      }
      if (variant.managed && mark <= premium * PROFIT_TARGET) {
        exitIdx = j;
        exitCost = premium * PROFIT_TARGET; // models the resting GTC fill
        reason = "profit-target";
        break;
      }
      if (variant.managed && dteLeft <= MANAGE_DTE) {
        exitIdx = j;
        exitCost = mark;
        reason = "dte-exit";
        break;
      }
    }
    if (exitIdx === -1) break; // ran out of history mid-trade: drop the open tail

    const pnl = (premium - exitCost) * 100;
    trades.push({
      symbol,
      variant: variant.key,
      entryDate,
      exitDate: bars[exitIdx]!.date,
      strike,
      premium: round2(premium),
      exitCost: round2(exitCost),
      pnl: Math.round(pnl),
      reason,
      win: pnl > 0,
      collateral: strike * 100,
    });
    i = exitIdx + 1; // re-enter the day after flat, one position per symbol
  }
  return trades;
}

export interface BtStats {
  variant: string;
  trades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  totalPnl: number;
  profitFactor: number | null;
  maxDrawdown: number;
  worstTrade: number;
}

export function stats(trades: BtTrade[], variant: string): BtStats {
  const t = trades.filter((x) => x.variant === variant).sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
  const wins = t.filter((x) => x.pnl > 0);
  const losses = t.filter((x) => x.pnl <= 0);
  const grossWin = wins.reduce((a, x) => a + x.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, x) => a + x.pnl, 0));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const x of t) {
    equity += x.pnl;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    variant,
    trades: t.length,
    winRate: t.length ? wins.length / t.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    totalPnl: equity,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdown: maxDd,
    worstTrade: t.length ? Math.min(...t.map((x) => x.pnl)) : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
