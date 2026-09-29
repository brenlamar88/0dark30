import type { Params } from "../types.js";

export interface SwingBar {
  date: string;
  close: number;
}

export interface SwingPosition {
  symbol: string;
  ruleVersion: string;
  entryDate: string;
  entryPrice: number;
  shares: number;
  stop: number;
  target: number;
  lastMarkedDate: string | null; // last session the exit rules evaluated this position
  status: "open" | "closed";
  exitDate: string | null;
  exitPrice: number | null;
  pnl: number | null;
  exitReason: "stop" | "target" | "time-stop" | null;
  sessionsHeld: number;
}

type SwingParams = NonNullable<Params["swing"]>;

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  return closes.slice(-n).reduce((a, b) => a + b, 0) / n;
}

/** Close-to-close volatility proxy: mean absolute daily change over n sessions. */
function volProxy(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const tail = closes.slice(-(n + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) sum += Math.abs(tail[i]! - tail[i - 1]!);
  return sum / n;
}

/**
 * Swing entry signal (swing-v1, PLAN.md 2.4): uptrend (close > 100d SMA) with
 * a pullback (close < 20d SMA). Deterministic; the module's value is
 * discipline (a stop that exists and fires), not prediction. Shadow-only
 * until the 6-month live-forward gate - there is no order path at all.
 */
export function swingEntrySignal(
  symbol: string,
  bars: SwingBar[],
  p: SwingParams,
): SwingPosition | null {
  const closes = bars.map((b) => b.close);
  const long = sma(closes, p.smaLong);
  const short = sma(closes, p.smaShort);
  const vol = volProxy(closes, p.volProxyPeriod);
  if (long === null || short === null || vol === null || vol <= 0) return null;
  const close = closes[closes.length - 1]!;
  if (!(close > long && close < short)) return null;
  const shares = Math.floor(p.notionalPerTradeUsd / close);
  if (shares < 1) return null;
  return {
    symbol,
    ruleVersion: p.ruleVersion,
    entryDate: bars[bars.length - 1]!.date,
    entryPrice: round2(close),
    shares,
    stop: round2(close - p.stopVolMult * vol),
    target: round2(close + p.targetVolMult * vol),
    lastMarkedDate: null,
    status: "open",
    exitDate: null,
    exitPrice: null,
    pnl: null,
    exitReason: null,
    sessionsHeld: 0,
  };
}

/** Exit check against today's close (close-only data: stops/targets fill at the close that breaches them). */
export function swingExitCheck(
  pos: SwingPosition,
  todayDate: string,
  todayClose: number,
  p: SwingParams,
): SwingPosition {
  const next = { ...pos, sessionsHeld: pos.sessionsHeld + 1 };
  let reason: SwingPosition["exitReason"] = null;
  if (todayClose <= pos.stop) reason = "stop";
  else if (todayClose >= pos.target) reason = "target";
  else if (next.sessionsHeld >= p.timeStopSessions) reason = "time-stop";
  if (reason) {
    next.status = "closed";
    next.exitDate = todayDate;
    next.exitPrice = round2(todayClose);
    next.exitReason = reason;
    next.pnl = round2((todayClose - pos.entryPrice) * pos.shares);
  }
  return next;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
