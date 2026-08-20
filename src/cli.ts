import { runPremarket } from "./cycles/premarket.js";
import { runPostclose } from "./cycles/postclose.js";
import { loadParams } from "./config.js";
import { Journal } from "./journal/journal.js";

const cmd = process.argv[2];

async function report(): Promise<void> {
  const params = loadParams();
  const journal = new Journal(params.ruleVersion);
  const rows = journal.scoreboardRows();
  if (rows.length === 0) {
    console.log("No scoreboard rows yet - run cycles first.");
    return;
  }
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const spyReturn =
    first.spy_close && last.spy_close ? (last.spy_close / first.spy_close - 1) * 100 : null;
  const pool = params.pool.simulatedValueUsd;
  const shadowReturn = ((last.shadow_realized_total + last.shadow_unrealized) / pool) * 100;
  console.log(`Scoreboard (${String(first.date)} -> ${String(last.date)}, ${rows.length} sessions)`);
  console.log(`  Shadow book:  realized $${Number(last.shadow_realized_total).toFixed(0)}, unrealized $${Number(last.shadow_unrealized).toFixed(0)} (${shadowReturn.toFixed(2)}% of $${pool} pool)`);
  console.log(`  SPY (null hypothesis): ${spyReturn === null ? "n/a" : spyReturn.toFixed(2) + "% over the same window"}`);
  console.log(`  Open ${last.shadow_open_count}, closed ${last.shadow_closed_count}`);
  console.log(`  Kill criteria live in PLAN.md 2.8 - the number above is pre-cost, pre-tax, and proves nothing until months accumulate.`);
}

switch (cmd) {
  case "premarket":
  case "screen": // alias: screen == premarket without pretending otherwise; both are shadow-only
    await runPremarket();
    break;
  case "postclose":
    await runPostclose();
    break;
  case "report":
    await report();
    break;
  default:
    console.log("usage: tsx src/cli.ts <premarket|postclose|report>");
    process.exit(1);
}
