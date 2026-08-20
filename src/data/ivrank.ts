import type { IvRank, OptionQuote } from "../types.js";
import type { Journal } from "../journal/journal.js";

/**
 * ATM IV proxy for the underlying: median IV of puts nearest 0.30-0.20 delta
 * in the screen's DTE window. Consistent day over day, which is what a rank
 * needs; absolute level matters less.
 */
export function atmIvProxy(puts: OptionQuote[]): number | null {
  const withIv = puts.filter((p) => p.iv !== null && p.delta !== null);
  if (withIv.length === 0) return null;
  const sorted = [...withIv].sort(
    (a, b) => Math.abs(Math.abs(a.delta!) - 0.25) - Math.abs(Math.abs(b.delta!) - 0.25),
  );
  const nearest = sorted.slice(0, Math.min(5, sorted.length)).map((p) => p.iv!);
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)]!;
}

/**
 * Percentile rank of today's IV vs trailing stored history (bootstraps from
 * day 1; flagged low-confidence until minObservations accumulate, per
 * PLAN.md - the threshold only hard-gates once history is meaningful).
 */
export async function ivRankFor(
  journal: Journal,
  symbol: string,
  todayIv: number | null,
  date: string,
  minObservations: number,
): Promise<IvRank> {
  if (todayIv === null) return { rank: null, observations: 0, confident: false };
  await journal.appendIv(symbol, date, todayIv);
  const history = await journal.ivHistory(symbol, 252);
  const past = history.filter((h) => h.date !== date).map((h) => h.iv);
  if (past.length === 0) return { rank: null, observations: 0, confident: false };
  const below = past.filter((iv) => iv < todayIv).length;
  const rank = Math.round((below / past.length) * 100);
  return { rank, observations: past.length, confident: past.length >= minObservations };
}
