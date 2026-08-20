/**
 * Black-Scholes machinery for the model-based backtest. Premiums here are
 * SYNTHETIC - priced from realized volatility, not from real market quotes -
 * which is the central, prominently-disclosed limitation of the study
 * (PLAN.md Part 1 #4: backtests inform development, never gate promotion).
 */

/** Standard normal CDF via Abramowitz-Stegun erf approximation (|err| < 1.5e-7). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  // tail = 1 - N(|x|)
  const tail = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - tail : tail;
}

export function putPrice(S: number, K: number, sigma: number, tauYears: number, r: number): number {
  if (tauYears <= 0) return Math.max(0, K - S);
  const st = sigma * Math.sqrt(tauYears);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * tauYears) / st;
  const d2 = d1 - st;
  return K * Math.exp(-r * tauYears) * normCdf(-d2) - S * normCdf(-d1);
}

/** Inverse normal CDF (Acklam's approximation) - used to solve strike from target delta. */
export function normInv(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pl = 0.02425;
  let q: number, r2: number;
  if (p < pl) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p <= 1 - pl) {
    q = p - 0.5;
    r2 = q * q;
    return ((((((a[0]! * r2 + a[1]!) * r2 + a[2]!) * r2 + a[3]!) * r2 + a[4]!) * r2 + a[5]!) * q) /
      (((((b[0]! * r2 + b[1]!) * r2 + b[2]!) * r2 + b[3]!) * r2 + b[4]!) * r2 + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

/** Strike whose Black-Scholes put delta magnitude equals targetAbsDelta. */
export function strikeForPutDelta(S: number, sigma: number, tauYears: number, r: number, targetAbsDelta: number): number {
  // |put delta| = N(-d1) = target  =>  d1 = -normInv(target)
  const d1 = -normInv(targetAbsDelta);
  const st = sigma * Math.sqrt(tauYears);
  return S * Math.exp((r + (sigma * sigma) / 2) * tauYears - d1 * st);
}

/** Trailing realized vol, annualized, over the last n log returns ending at index i (exclusive). */
export function realizedVolAt(closes: number[], i: number, n: number): number | null {
  if (i < n + 1) return null;
  const rets: number[] = [];
  for (let k = i - n; k < i; k++) rets.push(Math.log(closes[k]! / closes[k - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, x) => a + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252);
}
