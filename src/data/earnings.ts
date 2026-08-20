import { env } from "../config.js";

/**
 * Returns true if the symbol has an earnings date inside [from, to], false if
 * confirmed clear, null if unknown (no provider configured or provider error).
 * The risk engine treats null as a hard block for hasEarnings symbols -
 * "unknown catalyst" is not "no catalyst".
 */
export async function earningsInWindow(
  symbol: string,
  from: string,
  to: string,
): Promise<boolean | null> {
  if (!env.finnhubApiKey) return null;
  try {
    const url =
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}` +
      `&symbol=${encodeURIComponent(symbol)}&token=${env.finnhubApiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json: any = await res.json();
    const rows: any[] = json.earningsCalendar ?? [];
    return rows.some((r) => r.symbol === symbol);
  } catch {
    return null;
  }
}
