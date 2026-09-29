import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir, loadUniverse, repoRoot } from "../config.js";
import { dailyBars as fetchDailyBars } from "../data/alpaca.js";
import { backtestSymbol, stats, type BtBar, type BtTrade, type BtVariant } from "./engine.js";
import { renderBacktestPage, type BacktestResults } from "./report.js";

const YEARS = 3;

export const VARIANTS: BtVariant[] = [
  { key: "d20-managed", targetDelta: 0.2, dteTarget: 36, managed: true },
  { key: "d25-managed", targetDelta: 0.25, dteTarget: 36, managed: true },
  { key: "d30-managed", targetDelta: 0.3, dteTarget: 36, managed: true },
  { key: "d20-hold", targetDelta: 0.2, dteTarget: 36, managed: false },
  { key: "d25-hold", targetDelta: 0.25, dteTarget: 36, managed: false },
  { key: "d30-hold", targetDelta: 0.3, dteTarget: 36, managed: false },
];

export async function runBacktest(): Promise<void> {
  const universe = loadUniverse();
  const allTrades: BtTrade[] = [];
  const perSymbolYears: Record<string, { from: string; to: string; sessions: number }> = {};

  for (const entry of universe) {
    try {
      const bars = await fetchDailyBars(entry.symbol, YEARS * 252);
      if (bars.length < 100) {
        console.log(`skip ${entry.symbol}: only ${bars.length} bars`);
        continue;
      }
      perSymbolYears[entry.symbol] = {
        from: bars[0]!.date,
        to: bars[bars.length - 1]!.date,
        sessions: bars.length,
      };
      for (const v of VARIANTS) {
        allTrades.push(...backtestSymbol(entry.symbol, bars, v));
      }
      console.log(`${entry.symbol}: ${bars.length} sessions`);
    } catch (err) {
      console.error(`backtest ${entry.symbol} failed:`, err instanceof Error ? err.message : err);
    }
  }

  const allStats = VARIANTS.map((v) => stats(allTrades, v.key));
  const results: BacktestResults = {
    generatedAt: new Date().toISOString(),
    model: {
      pricing: "black-scholes on 21d trailing realized vol",
      riskFree: 0.04,
      dteTarget: 36,
      profitTarget: 0.5,
      manageDte: 21,
      fills: "model mid, zero spread/slippage/commissions",
      caveat: "synthetic premiums; informs development only, never a promotion gate (PLAN.md Part 1 #4)",
    },
    coverage: perSymbolYears,
    stats: allStats,
    trades: allTrades,
  };

  mkdirSync(path.join(dataDir, "backtest"), { recursive: true });
  writeFileSync(path.join(dataDir, "backtest", "results.json"), JSON.stringify(results, null, 1));
  const page = path.join(repoRoot, "docs", "backtest.html");
  writeFileSync(page, renderBacktestPage(results));
  console.log(
    `backtest done: ${allTrades.length} simulated trades across ${Object.keys(perSymbolYears).length} symbols -> ${page}`,
  );
}
