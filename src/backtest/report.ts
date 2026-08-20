import type { BtStats, BtTrade } from "./engine.js";

export interface BacktestResults {
  generatedAt: string;
  model: Record<string, unknown>;
  coverage: Record<string, { from: string; to: string; sessions: number }>;
  stats: BtStats[];
  trades: BtTrade[];
}

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CURVE_VARIANTS = [
  { key: "d20-managed", label: "0.20 delta, managed", color: "#3987e5" },
  { key: "d25-managed", label: "0.25 delta, managed", color: "#d95926" },
  { key: "d30-managed", label: "0.30 delta, managed", color: "#199e70" },
];

interface CurvePoint {
  date: string;
  values: Record<string, number>;
}

function buildCurves(trades: BtTrade[]): CurvePoint[] {
  const dates = [...new Set(trades.map((t) => t.exitDate))].sort();
  const cum: Record<string, number> = {};
  const byDate = new Map<string, BtTrade[]>();
  for (const t of trades) {
    const list = byDate.get(t.exitDate) ?? [];
    list.push(t);
    byDate.set(t.exitDate, list);
  }
  const points: CurvePoint[] = [];
  for (const d of dates) {
    for (const t of byDate.get(d) ?? []) cum[t.variant] = (cum[t.variant] ?? 0) + t.pnl;
    points.push({
      date: d,
      values: Object.fromEntries(CURVE_VARIANTS.map((v) => [v.key, cum[v.key] ?? 0])),
    });
  }
  return points;
}

function equityChart(points: CurvePoint[]): string {
  const W = 800;
  const H = 320;
  const PAD = { l: 64, r: 16, t: 16, b: 28 };
  if (points.length < 2) return `<p class="muted">Not enough simulated trades to draw a curve.</p>`;
  const all = points.flatMap((p) => CURVE_VARIANTS.map((v) => p.values[v.key] ?? 0));
  const lo = Math.min(0, ...all);
  const hi = Math.max(1, ...all);
  const x = (i: number) => PAD.l + (i / (points.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const ticks: number[] = [];
  const seen = new Set<string>();
  for (const t of [lo, hi, 0, lo + (hi - lo) / 2]) {
    if (!seen.has(money(t))) {
      seen.add(money(t));
      ticks.push(t);
    }
  }
  const paths = CURVE_VARIANTS.map(
    (v) =>
      `<path class="line" style="stroke:${v.color}" d="${points
        .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.values[v.key] ?? 0).toFixed(1)}`)
        .join(" ")}"/>`,
  ).join("");
  const data = JSON.stringify({
    dates: points.map((p) => p.date),
    series: CURVE_VARIANTS.map((v) => ({ label: v.label, values: points.map((p) => p.values[v.key] ?? 0) })),
  });
  return `
<figure class="chart" aria-label="Cumulative simulated profit and loss per rule variant">
<svg viewBox="0 0 ${W} ${H}" role="img" id="bt-chart">
${ticks
  .map(
    (t) =>
      `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/>` +
      `<text class="tick" x="${PAD.l - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${money(t)}</text>`,
  )
  .join("")}
${paths}
<line id="bt-xhair" class="xhair" y1="${PAD.t}" y2="${H - PAD.b}" x1="0" x2="0" visibility="hidden"/>
<text class="tick" x="${PAD.l}" y="${H - 8}">${points[0]!.date}</text>
<text class="tick" x="${W - PAD.r}" y="${H - 8}" text-anchor="end">${points[points.length - 1]!.date}</text>
<rect id="bt-capture" x="${PAD.l}" y="${PAD.t}" width="${W - PAD.l - PAD.r}" height="${H - PAD.t - PAD.b}" fill="transparent"/>
</svg>
<div id="bt-tooltip" class="tooltip" hidden></div>
<figcaption class="legend">${CURVE_VARIANTS.map(
    (v) => `<span><i class="swatch" style="background:${v.color}"></i>${esc(v.label)}</span>`,
  ).join("")}</figcaption>
</figure>
<script>
(function () {
  var data = ${data};
  var svg = document.getElementById("bt-chart"), cap = document.getElementById("bt-capture");
  var tip = document.getElementById("bt-tooltip"), xh = document.getElementById("bt-xhair");
  var PADL = ${PAD.l}, PADR = ${PAD.r}, W = ${W};
  function fmt(n) { return (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString(); }
  cap.addEventListener("mousemove", function (e) {
    var box = svg.getBoundingClientRect();
    var px = ((e.clientX - box.left) / box.width) * W;
    var i = Math.max(0, Math.min(data.dates.length - 1, Math.round(((px - PADL) / (W - PADL - PADR)) * (data.dates.length - 1))));
    var xpos = PADL + (i / (data.dates.length - 1)) * (W - PADL - PADR);
    xh.setAttribute("x1", xpos); xh.setAttribute("x2", xpos); xh.removeAttribute("visibility");
    tip.hidden = false;
    tip.innerHTML = "<strong>" + data.dates[i] + "</strong><br>" +
      data.series.map(function (s) { return s.label + ": " + fmt(s.values[i]); }).join("<br>");
    tip.style.left = Math.min(box.width - 220, (xpos / W) * box.width + 12) + "px";
    tip.style.top = "12px";
  });
  cap.addEventListener("mouseleave", function () { tip.hidden = true; xh.setAttribute("visibility", "hidden"); });
})();
</script>`;
}

export function renderBacktestPage(r: BacktestResults): string {
  const managed = r.trades.filter((t) => t.variant === "d25-managed");
  const points = buildCurves(r.trades);

  const statRows = r.stats
    .map(
      (s) => `<tr${s.variant === "d25-managed" ? ` class="hl"` : ""}><td>${esc(s.variant)}</td><td>${s.trades}</td>
<td>${(s.winRate * 100).toFixed(1)}%</td><td>${money(s.avgWin)}</td><td>${money(s.avgLoss)}</td>
<td>${s.avgLoss !== 0 ? Math.abs(s.avgLoss / (s.avgWin || 1)).toFixed(1) + "x" : "—"}</td>
<td>${money(s.totalPnl)}</td><td>${s.profitFactor === null ? "∞" : s.profitFactor.toFixed(2)}</td>
<td>${money(-s.maxDrawdown)}</td><td>${money(s.worstTrade)}</td></tr>`,
    )
    .join("\n");

  const bySymbol = new Map<string, BtTrade[]>();
  for (const t of managed) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }
  const symbolRows = [...bySymbol.entries()]
    .map(([sym, ts]) => {
      const wins = ts.filter((t) => t.win).length;
      const pnl = ts.reduce((a, t) => a + t.pnl, 0);
      const worst = Math.min(...ts.map((t) => t.pnl));
      return { sym, n: ts.length, wins, pnl, worst };
    })
    .sort((a, b) => b.pnl - a.pnl)
    .map(
      (s) => `<tr><td>${esc(s.sym)}</td><td>${s.n}</td><td>${((s.wins / s.n) * 100).toFixed(0)}%</td>
<td>${money(s.pnl)}</td><td>${money(s.worst)}</td></tr>`,
    )
    .join("\n");

  const losses = managed
    .filter((t) => !t.win)
    .sort((a, b) => a.pnl - b.pnl)
    .slice(0, 12)
    .map(
      (t) => `<tr><td>${t.entryDate} → ${t.exitDate}</td><td>${esc(t.symbol)}</td><td>$${t.strike}</td>
<td>${money(t.premium * 100)}</td><td>${money(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`,
    )
    .join("\n");

  const recent = [...managed]
    .sort((a, b) => (a.exitDate < b.exitDate ? 1 : -1))
    .slice(0, 40)
    .map(
      (t) => `<tr class="${t.win ? "w" : "l"}"><td>${t.entryDate}</td><td>${t.exitDate}</td><td>${esc(t.symbol)}</td>
<td>$${t.strike}</td><td>${money(t.premium * 100)}</td><td>${money(t.pnl)}</td><td>${esc(t.reason)}</td></tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>0dark30 backtest study</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0d1117; color:#e6edf3; font: 15px/1.5 system-ui, sans-serif; max-width: 940px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 2rem; }
  .muted, .tick { color:#8b949e; }
  a { color:#3987e5; }
  .warn { background:#2d1a1a; border:1px solid #e66767; border-radius:8px; padding: .9rem 1.1rem; }
  .warn strong { color:#e66767; }
  .chart { margin:1rem 0; position:relative; } svg { width:100%; height:auto; }
  .grid { stroke:#21262d; } .tick { font-size:11px; fill:#8b949e; }
  .line { fill:none; stroke-width:2; stroke-linejoin:round; }
  .xhair { stroke:#8b949e; stroke-width:1; stroke-dasharray:2 3; }
  .tooltip { position:absolute; background:#1c2128; border:1px solid #30363d; border-radius:6px; padding:.4rem .6rem; font-size:.85em; pointer-events:none; }
  .legend { display:flex; gap:1.2rem; flex-wrap:wrap; color:#c9d1d9; font-size:.85em; margin-top:.3rem; }
  .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:.4rem; }
  table { border-collapse:collapse; width:100%; font-size:.85em; }
  .scroll { overflow-x:auto; }
  th, td { border-bottom:1px solid #21262d; padding:.35rem .5rem; text-align:left; white-space:nowrap; }
  th { color:#8b949e; font-weight:600; }
  tr.hl td { background:#161b22; font-weight:600; }
  tr.w td:nth-child(6) { color:#199e70; } tr.l td:nth-child(6) { color:#e66767; }
</style></head><body>
<h1>0dark30 — model-based backtest study</h1>
<p><a href="index.html">← dashboard</a></p>
<div class="warn"><strong>Read this before the numbers.</strong> Premiums in this study are <strong>synthetic</strong> —
priced with Black-Scholes from each ETF's trailing realized volatility, because real historical option-chain data is
paid vendor data this system doesn't have. Fills are frictionless model mids: no spreads, no slippage, no commissions,
no IV-rank gate, no assignment mechanics. Real premiums are usually somewhat richer than modeled (implied &gt; realized
on average), but real fills are always worse. Per PLAN.md, a backtest <strong>informs rule design and never gates
promotion</strong> — the live-forward shadow record on the dashboard is the evidence that counts. Generated ${esc(r.generatedAt.slice(0, 16))}Z.</div>

<h2>Cumulative simulated P&amp;L — managed variants (~3 years, ${Object.keys(r.coverage).length} ETFs, 1 contract per name)</h2>
${equityChart(points)}

<h2>Variant comparison — "which strategy was best"</h2>
<p class="muted">d25-managed (highlighted) is the live rule set: ~0.25 delta, 36 DTE, buy back at 50% of premium, exit at 21 DTE. "hold" variants run the same entries with no management — the comparison shows what the management rules are worth.</p>
<div class="scroll"><table>
<thead><tr><th>Variant</th><th>Trades</th><th>Win rate</th><th>Avg win</th><th>Avg loss</th><th>Loss/win size</th><th>Total P&amp;L</th><th>Profit factor</th><th>Max drawdown</th><th>Worst trade</th></tr></thead>
<tbody>${statRows}</tbody>
</table></div>

<h2>Where the wins came from — by symbol (live rule set)</h2>
<div class="scroll"><table>
<thead><tr><th>Symbol</th><th>Trades</th><th>Win rate</th><th>Total P&amp;L</th><th>Worst trade</th></tr></thead>
<tbody>${symbolRows}</tbody>
</table></div>

<h2>The losses that mattered (worst 12, live rule set)</h2>
<p class="muted">This is the table to study. The strategy's whole risk lives here — note how losses cluster in vol-spike windows.</p>
<div class="scroll"><table>
<thead><tr><th>Window</th><th>Symbol</th><th>Strike</th><th>Premium</th><th>P&amp;L</th><th>Exit</th></tr></thead>
<tbody>${losses}</tbody>
</table></div>

<h2>Most recent 40 simulated trades (live rule set)</h2>
<div class="scroll"><table>
<thead><tr><th>Entry</th><th>Exit</th><th>Symbol</th><th>Strike</th><th>Premium</th><th>P&amp;L</th><th>Reason</th></tr></thead>
<tbody>${recent}</tbody>
</table></div>

<p class="muted">Full trade list: <code>data/backtest/results.json</code> in the repo. Rerun anytime by committing <code>.trigger</code> = <code>backtest</code>.</p>
</body></html>`;
}
