# v1 Spec (superseded — kept for reference)

> This is the original build spec, preserved verbatim so the critique in
> [`../PLAN.md`](../PLAN.md) Part 1 has something to point at. The v2 design in
> PLAN.md Part 2 supersedes it.

---

# Agentic Trading Assistant — Build Spec

**Goal:** A scheduled, agentic loop that generates specific, actionable option-income and swing candidates each morning, manages open positions, and executes only on your approval. Human-in-the-loop by design — it's decision-support with a trigger finger, not an autopilot.

**Core strategy:** The Wheel (cash-secured puts → assignment → covered calls → called away → repeat) as the primary engine, with an optional swing module that must clear a backtest before it touches real capital.

---

## 1. Design principle (read first)

The system's edge comes from **selling premium mechanically**, not predicting direction. Every design choice flows from that:

- **Wheel modules** rest on the variance risk premium (IV > realized vol on average). This is why the expectancy is positive. The risk is negative skew — many small wins, occasional large loss when a name gaps against you. You manage that with sizing, quality screens, and taking profit early.
- **Swing module** has no structural premium. It's a rules engine whose only job is to remove emotion and enforce stops. It gets capital *only if* it survives out-of-sample backtesting.
- **The agent never decides for you.** It scores, ranks, and proposes. You approve. This is both a safety rail (bugs in an auto-executing options bot are expensive) and a legal/practical one — you own every trade.

---

## 2. Agentic loop (the daily cycle)

```
06:30  Data pull        → prices, option chains, IV rank, earnings calendar, your open positions
06:35  Position mgmt    → check every open trade against exit/roll triggers
06:40  Candidate gen     → screen universe → score CSP / CC / swing candidates
06:45  Brief assembly    → rank, annotate with rationale + risk, write to Supabase
06:50  Deliver           → morning brief (HTML/email/dashboard) with approve buttons
--     On approval       → stage order → (paper OR live via broker API) → log fill
EOD    Reconcile         → mark-to-market, update P&L, log lessons
```

Run it as a scheduled serverless job (Vercel cron / a small worker). State lives in Supabase. Same architecture you already build in.

---

## 3. Tech stack (your terms)

| Layer | Choice | Notes |
|---|---|---|
| Scheduler | Vercel cron → serverless function | Or a Linux worker on your Tailscale box for anything long-running |
| State / log | Supabase (Postgres) | positions, orders, candidates, P&L, decision log |
| Market + options data | Broker API + data vendor (§4) | options chains are the hard/expensive part |
| Execution | Broker API, paper first | Schwab Trader API is the natural fit — you already have the account |
| Brief UI | React dashboard (dark, your usual) + email | approve/reject inline |
| Agent orchestration | Claude API via serverless | scoring rationale, brief prose, position-management reasoning |

---

## 4. Data layer

You need three feeds. The options chain is the one that makes or breaks it.

- **Equity prices + fundamentals + earnings dates** — cheap/abundant (many providers).
- **Live option chains with greeks + IV** — this is the constraint. Candidates: your broker's own API (Schwab/Tradier expose chains), or a data vendor (Polygon options tier, ORATS, Tradier). Delayed data is fine for a once-a-day brief; you don't need tick-level.
- **IV rank / IV percentile** — compute yourself from a rolling year of IV, or buy it. This drives *when* premium-selling is worth it.

> **Schwab note:** Schwab absorbed the old TD Ameritrade / thinkorswim API into the Schwab Trader API — it can do both chains and execution, which collapses two layers into one. Access terms and approval have shifted around since the migration, so verify current individual-developer access before you architect around it.

---

## 5. Strategy engine

### 5a. Cash-secured put (wheel entry)
Sell a put on a name you'd genuinely be happy to own 100 shares of.

- **Strike:** ~0.30 delta (≈30% risk-neutral chance of finishing ITM). Below current price.
- **DTE:** 30–45 days — the zone tastytrade's mechanical backtests favor for the theta/gamma tradeoff.
- **Capital reserved:** strike × 100. This is why a $30–$80 underlying keeps each position at $3k–$8k.
- **Effective cost basis if assigned:** strike − premium.
- **Return-on-capital:** premium ÷ (strike × 100), annualized × (365 ÷ DTE). Rank candidates on this.
- **Exit:** close at **50% of max profit** (don't hold to expiration for the last pennies). Roll at ~21 DTE if still open, or roll down-and-out if tested.

### 5b. Covered call (wheel income after assignment)
Once assigned the 100 shares, sell calls against them.

- **Strike:** ~0.30 delta, **above your cost basis** so a call-away is still a win.
- Same DTE, same 50%-profit management.
- **Watch:** upside is capped at strike + premium. And short ITM calls carry early-assignment risk right before an ex-dividend date — the engine must flag ex-div.

### 5c. Swing module (optional, gated)
Mechanical entry/exit rules — *not* a predictor.

- Configurable signals (e.g. trend + pullback + volatility filter). Treat them as hypotheses.
- **Hard requirement:** defined entry, stop-loss, and target on every trade; fixed % risk per trade; no averaging down.
- **Gate:** this module does not get real capital until it clears out-of-sample backtesting with realistic costs and slippage. If it can't beat buy-and-hold net of costs in paper, it stays off.

---

## 6. Screening / candidate universe

Filter the universe before scoring, or you'll get garbage candidates:

- **Optionable + liquid** — real open interest, tight bid/ask. Illiquid options quietly eat you on the spread.
- **IV rank elevated** — only sell premium when premium is actually rich (higher IV rank = better paid to take the risk).
- **No earnings inside the expiration cycle** — or explicitly flag and size down. Earnings gaps are the classic wheel blow-up.
- **Fundamentally ownable** — you may get assigned; only wheel names you'd hold.
- **Price fits capital** — so each 100-share/CSP position is a sane fraction of the account.

---

## 7. Risk management (the part that actually protects you)

- **Position sizing:** cap each position at a fixed % of total account (e.g. 5%). Never let one name dominate.
- **Sector concentration cap:** total exposure per sector limited.
- **Total capital deployed cap:** keep dry powder; don't run 100% allocated.
- **Max defined loss per swing trade:** enforced stop, sized so one loss is survivable.
- **Assignment / ex-div flags:** surfaced in the brief, not buried.
- **Tax-lot-aware logging:** the wheel cycles the same names repeatedly, so wash-sale and short-term-gain tracking has to be built into the log from day one, not bolted on later. Premium and short-term gains are ordinary income — the log should make tax season mechanical.

---

## 8. Execution model

1. **Paper first, for weeks.** Non-negotiable. Run the full loop against a paper account and reconcile daily until the logic is boring and correct.
2. **Human-in-the-loop live.** Brief proposes → you approve → order stages. No silent auto-fills at the start.
3. **Full auto (optional, much later).** Only after the paper and approved-live phases have earned trust, and only with hard kill-switches (max daily loss → halt, position count cap, connectivity-loss → flatten-or-freeze rule).

---

## 9. Backtesting & validation (the honest hard part)

- **Wheel backtesting needs historical option data** — priced, with greeks, across cycles. This data is expensive and messy (CBOE DataShop, ORATS, etc.). Budget for it or accept you're validating forward in paper instead.
- **Beware overfit.** Any swing ruleset can be tuned to look great in-sample. Only out-of-sample / walk-forward results mean anything.
- **Model real costs:** commissions, the bid/ask spread you actually cross, and slippage. Most retail "edges" vanish here.

---

## 10. The morning brief (agent output)

Each candidate card:

- **Trade:** e.g. "Sell SYMBOL 45-DTE $XX put, 0.30Δ"
- **Premium / return-on-capital (annualized)**
- **Capital required**
- **Why it screened** — IV rank, liquidity, no-earnings, ownable
- **Risk note** — assignment level, effective basis, any ex-div/earnings flag
- **[Approve] [Skip]**

Plus a **positions panel** (every open trade with its exit/roll trigger status) and a **P&L / realized-income** summary.

---

## 11. Build phases

Ship each phase as a **complete, usable thing** before starting the next — a paper-only brief with no execution is genuinely useful on its own and worth stopping to actually finish.

- **Phase 1 — Read-only brief (paper).** Data layer + wheel screener + morning brief. No execution. This alone is a real product; run it for weeks.
- **Phase 2 — Position management + logging.** Track (paper) positions, fire exit/roll triggers, log P&L in Supabase.
- **Phase 3 — Approved live execution.** Wire the broker API, human-in-the-loop only, small size.
- **Phase 4 — Swing module,** gated behind its backtest.
- **Phase 5 (optional) — Guarded automation,** with kill-switches.

---

*This is a build/decision-support spec, not investment advice. It keeps you approving every trade on purpose — the agent's job is consistency and risk discipline, not making the call for you.*
