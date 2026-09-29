import type { Proposal } from "../types.js";
import type { SwingPosition } from "../signals/swing.js";
import { explainCheck, verdictHeadline } from "../risk/explain.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function proposalCard(p: Proposal): string {
  const blocked = p.verdict === "blocked";
  const failedChecks = p.checks.filter((c) => !c.pass);
  const flags = p.llm?.flags ?? [];
  return `
  <article class="card${blocked ? " blocked" : ""}">
    <header>
      <h3>${blocked ? "BLOCKED " : ""}Sell ${esc(p.underlying)} ${p.expiry} $${p.strike} ${p.strategy === "cc" ? "call (covered)" : "put"} (${p.dte} DTE, ${p.delta === null ? "?" : Math.abs(p.delta).toFixed(2)}&Delta;)</h3>
      <span class="mono">${esc(p.occSymbol)}</span>
    </header>
    <dl>
      <div><dt>Premium (mid)</dt><dd>${money(p.premiumAtMid)}</dd></div>
      <div><dt>Collateral</dt><dd>${money(p.collateral)}</dd></div>
      <div><dt>Annualized RoC (bid)</dt><dd>${pct(p.rocAnnualizedAtBid)}</dd></div>
      <div><dt>IV rank</dt><dd>${p.ivRank.rank ?? "n/a"}${p.ivRank.confident ? "" : " (low confidence)"}</dd></div>
      <div><dt>Quote</dt><dd>${p.bid.toFixed(2)} / ${p.ask.toFixed(2)}</dd></div>
      <div><dt>${p.strategy === "cc" ? "Share basis" : "Effective basis if assigned"}</dt><dd>${p.strategy === "cc" ? (p.coveredBasis === null || p.coveredBasis === undefined ? "?" : p.coveredBasis.toFixed(2)) : (p.strike - p.mid).toFixed(2)}</dd></div>
    </dl>
    <p class="${blocked ? "fail" : "pass"}">${esc(verdictHeadline(p.checks))}</p>
    ${failedChecks
      .map(
        (c) =>
          `<p class="fail">✗ ${esc(c.detail)}<br><span class="why">${esc(explainCheck(c))}</span></p>`,
      )
      .join("")}
    <details class="checks"><summary>All ${p.checks.length} risk checks</summary>
      ${p.checks
        .map(
          (c) =>
            `<p class="${c.pass ? "ok" : "fail"}">${c.pass ? "✓" : "✗"} <strong>${esc(c.name)}</strong> - ${esc(c.detail)}<br><span class="why">${esc(explainCheck(c))}</span></p>`,
        )
        .join("")}
    </details>
    ${p.llm ? `<p class="rationale">${esc(p.llm.rationale)}</p>` : ""}
    ${flags
      .map((f) => `<p class="flag ${f.severity}">${f.severity.toUpperCase()}: ${esc(f.flag)} <span class="mono">(${esc(f.source)})</span></p>`)
      .join("")}
    ${p.llm?.veto ? `<p class="fail">ANALYST VETO - logged; mechanical proposal stands in the journal either way</p>` : ""}
    ${p.screenNotes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}
    <footer>Approval id: <strong class="mono">${p.id.slice(0, 8)}</strong> · TTL ${p.ttlHours}h from creation · Management once filled: buy-to-close at 50% of premium, manage at 21 DTE.</footer>
  </article>`;
}

export function renderBrief(
  date: string,
  proposals: Proposal[],
  context: {
    marketNote: string | null;
    spyRealizedVol: number | null;
    ruleVersion: string;
    openShadowCount: number;
    llmDegraded: boolean;
    screenedOut?: { symbol: string; reason: string }[];
    mode?: "shadow" | "paper";
    swing?: { ruleVersion: string; entriesToday: string[]; open: SwingPosition[] };
  },
): string {
  const proposed = proposals.filter((p) => p.verdict === "proposed");
  const blocked = proposals.filter((p) => p.verdict === "blocked");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>0dark30 - ${date}</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#e6edf3; font: 15px/1.5 system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h3 { font-size: 1rem; margin: 0; }
  .mono { font-family: ui-monospace, monospace; color: #8b949e; font-size: .85em; }
  .card { border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  .card.blocked { opacity: .6; border-style: dashed; }
  .card header { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .5rem; margin: .8rem 0; }
  dt { color: #8b949e; font-size: .8em; } dd { margin: 0; font-weight: 600; }
  .fail { color: #f85149; } .pass { color: #199e70; } .ok { color: #199e70; } .flag.warning { color: #d29922; } .flag.veto { color: #f85149; } .flag.info, .note { color: #8b949e; font-size: .9em; }
  .why { color: #8b949e; font-size: .88em; font-style: italic; }
  details.checks { margin: .5rem 0; } details.checks summary { cursor: pointer; color: #8b949e; font-size: .85em; }
  details.checks p { margin: .4rem 0 .4rem .8rem; font-size: .9em; }
  .rationale { border-left: 3px solid #30363d; padding-left: .8rem; color: #c9d1d9; }
  footer { color: #8b949e; font-size: .8em; margin-top: .5rem; }
  .banner { background: #1c2128; border: 1px solid #30363d; border-radius: 8px; padding: .8rem 1rem; }
</style></head><body>
<h1>0dark30 morning brief - ${date}</h1>
${
  context.mode === "paper"
    ? `<p class="banner"><strong>PAPER MODE (Phase 2).</strong> Proposals below are staged to the Alpaca <em>paper</em> account only after your approval - no real money anywhere. Approve/reject by short id before the TTL: commit <span class="mono">approvals/${date}.json</span> (<span class="mono">{"approve": ["ab12cd34"], "reject": []}</span>) or reply to the Telegram bot if configured. Unapproved proposals expire and are journaled. Rule version <span class="mono">${esc(context.ruleVersion)}</span>; not financial advice.</p>`
    : `<p class="banner"><strong>SHADOW MODE.</strong> Nothing here is an order, a recommendation, or financial advice; these are journaled outputs of mechanical rule version <span class="mono">${esc(context.ruleVersion)}</span> being evaluated against its own scoreboard. Simulated pool: $50,000.</p>`
}
${context.marketNote ? `<p>${esc(context.marketNote)}</p>` : ""}
${context.llmDegraded ? `<p class="note">LLM analyst layer unavailable this run - mechanical output only (by design, the brief never depends on it).</p>` : ""}
<p class="note">SPY 20d realized vol: ${context.spyRealizedVol === null ? "unavailable" : (context.spyRealizedVol * 100).toFixed(1) + "%"} - open shadow positions: ${context.openShadowCount}</p>
<h2>Proposals (${proposed.length})</h2>
${proposed.length ? proposed.map(proposalCard).join("\n") : "<p>No candidates cleared the screen and risk engine today. A quiet day is a valid output.</p>"}
${blocked.length ? `<h2>Blocked by risk engine (${blocked.length})</h2>${blocked.map(proposalCard).join("\n")}` : ""}
${
  context.screenedOut?.length
    ? `<h2>Screened out (${context.screenedOut.length})</h2>
<p class="note">Every universe symbol that produced no proposal today, and which rule eliminated it. "No candidate" is a decision too.</p>
${context.screenedOut.map((s) => `<p class="note"><strong>${esc(s.symbol)}</strong> — ${esc(s.reason)}</p>`).join("\n")}`
    : ""
}${
  context.swing
    ? `<h2>Swing module — ${esc(context.swing.ruleVersion)} (shadow-gated)</h2>
<p class="note">Signals only, no orders in any mode: this module must beat SPY over a 6-month live-forward window before it touches even paper capital (PLAN.md 2.4). Entry: uptrend + pullback; every position carries a stop, target, and 20-session time stop.</p>
${context.swing.entriesToday.length ? `<p>New shadow entries today: <strong>${context.swing.entriesToday.map(esc).join(", ")}</strong></p>` : ""}
${
  context.swing.open.length
    ? `<div class="scroll"><table><thead><tr><th>Sym</th><th>Entered</th><th>Entry</th><th>Shares</th><th>Stop</th><th>Target</th><th>Held</th></tr></thead><tbody>${context.swing.open
        .map(
          (s) =>
            `<tr><td>${esc(s.symbol)}</td><td>${s.entryDate}</td><td>${s.entryPrice}</td><td>${s.shares}</td><td>${s.stop}</td><td>${s.target}</td><td>${s.sessionsHeld}d</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="note">No open swing positions.</p>`
}`
    : ""
}
</body></html>`;
}
