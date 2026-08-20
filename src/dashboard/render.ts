import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../config.js";
import type { Params, Proposal } from "../types.js";
import type { Journal } from "../journal/journal.js";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface SeriesPoint {
  date: string;
  shadow: number; // cumulative shadow book P&L in dollars
  spy: number; // SPY buy-and-hold P&L on the same pool, dollars
}

function buildSeries(rows: Record<string, any>[], pool: number): SeriesPoint[] {
  const byDate = new Map<string, Record<string, any>>();
  for (const r of rows) byDate.set(String(r.date), r); // last row per date wins
  const dates = [...byDate.keys()].sort();
  const firstSpy = dates.map((d) => byDate.get(d)!.spy_close).find((c) => typeof c === "number");
  return dates.map((d) => {
    const r = byDate.get(d)!;
    const spyPnl =
      typeof r.spy_close === "number" && typeof firstSpy === "number"
        ? (r.spy_close / firstSpy - 1) * pool
        : 0;
    return {
      date: d,
      shadow: (r.shadow_realized_total ?? 0) + (r.shadow_unrealized ?? 0),
      spy: spyPnl,
    };
  });
}

/** Inline-SVG line chart: 2 series, crosshair tooltip, no external libs. */
function lineChart(series: SeriesPoint[]): string {
  const W = 760;
  const H = 300;
  const PAD = { l: 56, r: 16, t: 16, b: 28 };
  if (series.length === 0) {
    return `<p class="muted">No scoreboard rows yet — the chart appears after the first postclose cycle.</p>`;
  }
  const values = series.flatMap((p) => [p.shadow, p.spy]);
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values, 1);
  const x = (i: number) =>
    PAD.l + (series.length === 1 ? 0 : (i / (series.length - 1)) * (W - PAD.l - PAD.r));
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const pathFor = (key: "shadow" | "spy") =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  // Dedupe tick labels: with tiny ranges the rounded mid-tick can collide
  // with an endpoint label (e.g. day zero renders $0/$1/$1 otherwise).
  const ticks: number[] = [];
  const tickLabels = new Set<string>();
  for (const t of [lo, hi, lo + (hi - lo) / 2]) {
    if (!tickLabels.has(money(t))) {
      tickLabels.add(money(t));
      ticks.push(t);
    }
  }
  const zeroY = y(0);
  const points = series
    .map(
      (p, i) =>
        `<circle class="pt s1" data-i="${i}" cx="${x(i).toFixed(1)}" cy="${y(p.shadow).toFixed(1)}" r="3"/>` +
        `<circle class="pt s2" data-i="${i}" cx="${x(i).toFixed(1)}" cy="${y(p.spy).toFixed(1)}" r="3"/>`,
    )
    .join("");
  const data = JSON.stringify(series);
  return `
<figure class="chart" aria-label="Cumulative shadow book profit and loss versus SPY buy-and-hold on the same pool">
<svg viewBox="0 0 ${W} ${H}" role="img" id="pnl-chart">
  ${ticks
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="tick" x="${PAD.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${money(t)}</text>`,
    )
    .join("")}
  <line class="zero" x1="${PAD.l}" x2="${W - PAD.r}" y1="${zeroY.toFixed(1)}" y2="${zeroY.toFixed(1)}"/>
  <path class="line s1" d="${pathFor("shadow")}"/>
  <path class="line s2" d="${pathFor("spy")}"/>
  ${points}
  <line id="xhair" class="xhair" y1="${PAD.t}" y2="${H - PAD.b}" x1="0" x2="0" visibility="hidden"/>
  <text class="tick" x="${PAD.l}" y="${H - 8}">${series[0]!.date}</text>
  <text class="tick" x="${W - PAD.r}" y="${H - 8}" text-anchor="end">${series[series.length - 1]!.date}</text>
  <rect id="hover-capture" x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/>
</svg>
<div id="tooltip" class="tooltip" hidden></div>
<figcaption class="legend">
  <span><i class="swatch s1"></i>Shadow book P&amp;L</span>
  <span><i class="swatch s2"></i>SPY buy-and-hold (null hypothesis)</span>
</figcaption>
</figure>
<script>
(function () {
  var data = ${data};
  var svg = document.getElementById("pnl-chart");
  var cap = document.getElementById("hover-capture");
  var tip = document.getElementById("tooltip");
  var xh = document.getElementById("xhair");
  var PADL = ${PAD.l}, PADR = ${PAD.r}, W = ${W};
  function fmt(n) { return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString(); }
  cap.addEventListener("mousemove", function (e) {
    var box = svg.getBoundingClientRect();
    var px = ((e.clientX - box.left) / box.width) * W;
    var frac = (px - PADL) / (W - PADL - PADR);
    var i = Math.max(0, Math.min(data.length - 1, Math.round(frac * (data.length - 1))));
    var xpos = PADL + (data.length === 1 ? 0 : (i / (data.length - 1)) * (W - PADL - PADR));
    xh.setAttribute("x1", xpos); xh.setAttribute("x2", xpos); xh.removeAttribute("visibility");
    tip.hidden = false;
    tip.innerHTML = "<strong>" + data[i].date + "</strong><br>Shadow: " + fmt(data[i].shadow) + "<br>SPY: " + fmt(data[i].spy);
    tip.style.left = Math.min(box.width - 170, (xpos / W) * box.width + 12) + "px";
    tip.style.top = "12px";
  });
  cap.addEventListener("mouseleave", function () { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
})();
</script>`;
}

function statTile(label: string, value: string, note?: string): string {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${esc(value)}</div>${note ? `<div class="tile-note">${esc(note)}</div>` : ""}</div>`;
}

export function renderDashboard(journal: Journal, params: Params): string {
  const pool = params.pool.simulatedValueUsd;
  const rows = journal.scoreboardRows();
  const series = buildSeries(rows, pool);
  const last = series[series.length - 1];
  const lastRow = rows[rows.length - 1];

  const dates = journal.allProposalDates();
  const allProposals: Proposal[] = dates.flatMap((d) => journal.loadProposals(d));
  const open = allProposals.filter((p) => p.shadowStatus === "open");
  const closed = allProposals.filter((p) => p.shadowStatus === "closed");

  // One IV observation lands per symbol per session, so session count tracks
  // the bootstrap without re-reading every iv file.
  const ivObs = rows.length;
  const ivTarget = params.screen.ivRankMinObservations;

  const freezeFile = path.join(repoRoot, "data", "state", "freeze.json");
  const frozen = existsSync(freezeFile) ? JSON.parse(readFileSync(freezeFile, "utf8")) : null;

  const recentProposals = [...allProposals]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, 30);

  const proposalRows = recentProposals
    .map(
      (p) => `<tr>
<td>${p.date}</td><td>${esc(p.underlying)}</td><td class="mono">${esc(p.occSymbol)}</td>
<td>${p.delta === null ? "?" : Math.abs(p.delta).toFixed(2)}</td><td>${p.dte}</td>
<td>${money(p.premiumAtMid)}</td><td>${money(p.collateral)}</td>
<td>${(p.rocAnnualizedAtBid * 100).toFixed(1)}%</td>
<td>${p.verdict === "blocked" ? "blocked" : p.shadowStatus}${p.closedReason ? ` (${esc(p.closedReason)})` : ""}</td>
<td>${p.shadowPnl === null ? "—" : money(p.shadowPnl)}</td></tr>`,
    )
    .join("\n");

  const scoreboardRows = [...rows]
    .reverse()
    .slice(0, 20)
    .map(
      (r) => `<tr><td>${esc(String(r.date))}</td><td>${r.spy_close ?? "—"}</td>
<td>${money(r.shadow_realized_total ?? 0)}</td><td>${money(r.shadow_unrealized ?? 0)}</td>
<td>${r.shadow_open_count ?? 0}</td><td>${r.shadow_closed_count ?? 0}</td></tr>`,
    )
    .join("\n");

  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>0dark30 dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#e6edf3; font: 15px/1.5 system-ui, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  .muted, .tick { color:#8b949e; } .mono { font-family: ui-monospace, monospace; font-size: .85em; }
  .banner { background:#1c2128; border:1px solid #30363d; border-radius:8px; padding:.8rem 1rem; }
  .banner.freeze { border-color:#e66767; color:#e66767; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:.8rem; margin:1rem 0; }
  .tile { border:1px solid #30363d; border-radius:8px; padding: .7rem .9rem; }
  .tile-label { color:#8b949e; font-size:.75em; text-transform:uppercase; letter-spacing:.05em; }
  .tile-value { font-size:1.3rem; font-weight:650; margin-top:.15rem; }
  .tile-note { color:#8b949e; font-size:.8em; }
  .chart { margin:1rem 0; position:relative; }
  svg { width:100%; height:auto; }
  .grid { stroke:#21262d; stroke-width:1; } .zero { stroke:#30363d; stroke-width:1; stroke-dasharray:4 3; }
  .tick { font-size:11px; fill:#8b949e; }
  .line { fill:none; stroke-width:2; stroke-linejoin:round; } .line.s1 { stroke:#3987e5; } .line.s2 { stroke:#d95926; }
  .pt { fill:#0d1117; stroke-width:2; } .pt.s1 { stroke:#3987e5; } .pt.s2 { stroke:#d95926; }
  .xhair { stroke:#8b949e; stroke-width:1; stroke-dasharray:2 3; }
  .tooltip { position:absolute; background:#1c2128; border:1px solid #30363d; border-radius:6px; padding:.4rem .6rem; font-size:.85em; pointer-events:none; }
  .legend { display:flex; gap:1.2rem; color:#c9d1d9; font-size:.85em; margin-top:.3rem; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:.4rem; }
  .swatch.s1 { background:#3987e5; } .swatch.s2 { background:#d95926; }
  table { border-collapse:collapse; width:100%; font-size:.85em; }
  .scroll { overflow-x:auto; }
  th, td { border-bottom:1px solid #21262d; padding:.35rem .5rem; text-align:left; white-space:nowrap; }
  th { color:#8b949e; font-weight:600; }
  a { color:#3987e5; }
</style></head><body>
<h1>0dark30 — shadow dashboard</h1>
<p class="banner">Phase 1, <strong>shadow mode</strong>: simulated $${pool.toLocaleString()} pool, rule version <span class="mono">${esc(params.ruleVersion)}</span>, no orders anywhere. Not financial advice. Generated ${generatedAt}.</p>
${frozen ? `<p class="banner freeze">TRADING FROZEN: ${esc(String(frozen.reason ?? "unexplained divergence"))} (${esc(String(frozen.at ?? ""))}) — clear data/state/freeze.json with a journaled reason to resume.</p>` : ""}
${dates.length ? `<p><a href="briefs/${dates[dates.length - 1]}.html">Latest morning brief (${dates[dates.length - 1]}) →</a></p>` : ""}
<div class="tiles">
${statTile("Shadow book P&L", last ? money(last.shadow) : "—", "realized + unrealized, pre-cost")}
${statTile("SPY same-pool P&L", last ? money(last.spy) : "—", "the null hypothesis")}
${statTile("Open / closed", `${open.length} / ${closed.length}`, "shadow positions")}
${statTile("Sessions", String(rows.length), "postclose rows recorded")}
${statTile("IV-rank confidence", `${Math.min(ivObs, ivTarget)}/${ivTarget}`, ivObs >= ivTarget ? "gate active" : "bootstrapping — gate advisory")}
</div>
<h2>Cumulative P&amp;L vs the null hypothesis</h2>
${lineChart(series)}
<h2>Recent proposals</h2>
<div class="scroll"><table>
<thead><tr><th>Date</th><th>Sym</th><th>Contract</th><th>Δ</th><th>DTE</th><th>Prem</th><th>Collat</th><th>RoC/yr</th><th>Status</th><th>P&amp;L</th></tr></thead>
<tbody>${proposalRows || `<tr><td colspan="10" class="muted">none yet</td></tr>`}</tbody>
</table></div>
<h2>Scoreboard (last 20 sessions)</h2>
<div class="scroll"><table>
<thead><tr><th>Date</th><th>SPY close</th><th>Realized</th><th>Unrealized</th><th>Open</th><th>Closed</th></tr></thead>
<tbody>${scoreboardRows || `<tr><td colspan="6" class="muted">none yet</td></tr>`}</tbody>
</table></div>
<p class="muted">Kill criteria and gates live in PLAN.md. Numbers are pre-cost and pre-tax; nothing here proves anything until months accumulate.</p>
</body></html>`;
}

export function writeDashboard(journal: Journal, params: Params): string {
  const outDir = path.join(repoRoot, "docs");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "index.html");
  writeFileSync(file, renderDashboard(journal, params));
  return file;
}
