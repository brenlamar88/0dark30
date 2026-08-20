# 0dark30 — Personal Agentic Trading Platform

**Status:** Planning. Nothing here is built yet, and per this plan, nothing trades live until Phase 3's gate is passed.
**Audience:** One person. This is a personal-use system, not a product. Every design decision below exploits that fact.
**Not financial advice.** This is a software and process design document.

---

## Part 1 — Holes in the v1 plan

The v1 spec got a lot right: wheel-first with the swing module explicitly gated, human approval on every order, paper-first as non-negotiable, tax-lot-aware logging from day one, the 50%-profit / 21-DTE management rules, and the warning that most retail "edges" die in costs. Keep all of that — Part 2 does.

It also has ten real holes. In rough order of how much money each one could cost:

### 1. "The wheel monetizes the variance risk premium" is oversold at the single-stock level

The VRP is well-documented **at the index level** (SPX options persistently imply more volatility than realizes). At the **single-name** level — which is where a 100-share wheel lives — the premium is smaller, noisier, and frequently negative around catalysts. Single-stock implied vol is often *correctly* elevated: the market knows earnings, FDA decisions, and guidance risk are coming. Selling that premium isn't harvesting a mispricing; it's getting paid fairly to hold gap risk.

The v1 plan named the negative skew and then didn't design around it. A wheel portfolio looks like steady income until one -35% overnight gap on an assigned name erases 18 months of premium. The design consequence isn't "don't wheel" — it's that **catalyst avoidance, diversification minimums, and single-name loss caps are the strategy**, not accessories to it. Part 2 hard-codes them.

### 2. The capital math is half-done — per-position, never account-level

V1 §5a correctly sizes a position ($30–$80 underlyings → $3k–$8k per CSP) and §7 caps each at ~5% of the account. Put those two numbers together and the spec silently assumes a **$60k–$160k account** — without ever asking what the account actually is. A minimally diversified wheel (8–10 names, uncorrelated-ish sectors) needs **$40k–$100k+ of dedicated capital**, or the "diversified wheel" is actually 2–3 concentrated positions wearing a strategy costume. Below that, the honest universe shrinks to lower-priced names — which skews toward junkier, gappier stocks — or to liquid ETF wheels in the $20–$80/share range.

Also unasked: cash vs. margin account, taxable vs. IRA, and the **PDT rule** — swing trading in a margin account under $25k equity gets you flagged after 4 day trades in 5 business days. Phase 0 exists to answer these before any code is written, because the answers change the universe, the module list, and the tax design.

### 3. The 06:30 daily loop is the wrong shape for managing short options

V1's cycle runs position management once, pre-market, then reconciles at EOD. That's fine for *finding* trades and directly contradicts its own management rules for *holding* them: §5a says "close at 50% of max profit," but the 50% mark gets hit at 11:47 on a Tuesday, not at 6:35 the next morning — by which time the edge of early profit-taking has partly evaporated or reversed. Same problem for delta breaches and **early-assignment risk on short calls the day before ex-dividend** (§5b flags ex-div but the loop only looks once a day). A tick-by-tick daemon is the wrong fix — over-engineered and fragile for one person.

The correct shape is in between: **scheduled runs a few times per trading day + broker-side resting orders doing the fast work**. When a position opens, a GTC limit order to close at the profit target goes on *at the broker* immediately — the exchange watches tick-by-tick so the bot doesn't have to. The bot's intraday runs only handle what resting orders can't (roll decisions, delta breaches, ex-div checks).

### 4. The backtest gate is a p-hacking machine, even with v1's own caveats

V1 §9 correctly warns "only out-of-sample / walk-forward results mean anything" — and then §5c/§11 still make a backtest the gate. The problem is structural, not procedural: one person with unlimited retries against a *fixed* historical dataset will eventually produce a ruleset that passes any out-of-sample split, because every failed attempt leaks information about the holdout into the next attempt. Survivorship bias in the ticker universe and fantasy fills pile on top. A backtest gate one person controls will always eventually be passed, which means it gates nothing.

The v2 gate is **live-forward only**: the swing engine must run in shadow mode (real-time signals, logged, no money) for a fixed window (6 months) and beat buying SPY on the same dates after modeled costs. Backtests are allowed for *development*, never for *promotion*. And even a passed gate earns a capped capital allocation, not the account.

### 5. The LLM is in the wrong seat

V1 §3 assigns Claude "scoring rationale, brief prose, **position-management reasoning**." The first two are right; the third is the dangerous one. Position management is exactly where you need deterministic, versioned behavior — same inputs, same outputs, forever — because that's the only way a track record means anything and the only way a 2 a.m. bug is even findable. An LLM "reasoning" about whether to roll a tested put is a noise generator with a confident prose style. The redesign is strict:

- **Signals are mechanical.** Deterministic, versioned rules. Same inputs → same outputs, forever, so the track record means something.
- **The LLM is the analyst, never the oracle.** It reads the mechanical candidates plus news/filings/calendar and does three things: writes the human-readable rationale, **flags** hazards the screen can't see (pending litigation, CEO just left, acquisition rumor — as vetoes/warnings, never as originations), and runs the conversational interface.
- An LLM veto is logged and scored too. If its vetoes don't add value over 6 months, remove its veto power.

### 6. Human-in-the-loop was a phrase, not a design

"You approve trades" needs an actual order lifecycle or it decays into rubber-stamping or missed windows. V2 specifies: `proposed → approved/rejected/expired → staged → working → filled/cancelled → managed → closed`, with proposals delivered as push messages with one-tap approve, **every proposal carrying a TTL** (unapproved by cutoff = expired, logged), and approval always placing **limit orders, never market**.

### 7. Kill switches arrive three phases too late

V1 has kill switches — max-daily-loss halt, position-count cap, connectivity-loss freeze — but files them under **Phase 5, "guarded automation, optional, much later"** (§8.3). Circuit breakers aren't a feature of the autopilot; they're a feature of the *first live dollar*. A human-approved system fails plenty of expensive ways without automation: you approve trades during a drawdown you haven't noticed compounding, the wheel keeps proposing adds into a vol spike, a broken data feed prices proposals off stale chains. V2 hard-codes the breakers from Phase 1 (they gate proposals, so they're testable in shadow mode) and makes them un-overridable without editing code and redeploying: max drawdown halt, per-position loss cap, new-trade freeze on vol-regime spike, and a "system disagrees with broker" freeze (see #8).

### 8. V1's "reconcile" is P&L accounting, not state reconciliation

V1's EOD step reconciles *mark-to-market* — it updates prices on positions the database already believes in. The hard problem is the database being **wrong about what exists**: partial fills, an order you cancelled that filled anyway, an assignment that happened overnight, a trade you made manually from your phone that the bot doesn't know about. If bot state and broker state diverge silently, the risk engine is computing limits against fiction and every downstream number is decorative. V2 makes state reconciliation a first-class component: broker positions are the source of truth, a reconcile pass runs before every scheduled cycle (not just EOD), and any unexplained delta **freezes new trades** until acknowledged.

### 9. The Schwab question, now settled — and it changes the architecture

- **Schwab Trader API** is available to individual developers and covers equities + options (quotes, chains, orders). But its refresh token **hard-expires every 7 days** with no extension — meaning a fully unattended agent breaks weekly without a manual re-auth ritual. Livable for a human-in-the-loop system (fold re-auth into a weekly review); disqualifying for "set and forget."
- **Schwab has no true paper-trading API.** You cannot validate the execution path against Schwab without real money.
- **Alpaca** has options trading (including multi-leg) **enabled by default in its paper environment**, with the same API shape as live, zero commissions, and decent market data.

Consequence: **build a broker-adapter interface from day one.** Validate everything on Alpaca paper (Phases 1–2). Go live on Schwab where the real money is (Phase 3), with the weekly re-auth folded into the Sunday review ritual — or, simplest possible Phase 3: the bot proposes and *you* place the approved order in the Schwab app, which delays the execution-integration work until the system has proven it deserves it.

### 10. Nothing measures the bot against doing nothing

V1 §10 shows a P&L / realized-income summary — an absolute number with no benchmark. Realized wheel premium *always* looks like income; the question is whether the whole pool beat parking the same capital in SPY, after costs and taxes. Without that comparison the bot "feels" useful forever. V2 builds the scoreboard before the trader: every proposal (including rejected and expired ones) is journaled with a full market snapshot, and a monthly report compares realized results against (a) SPY buy-and-hold on the same capital and (b) the counterfactual of taking *every* proposal. If the bot can't beat the benchmark after 12 live months, the plan's own kill criteria say to shut it off. That's a feature.

---

## Part 2 — The v2 design

### 2.0 Prime directives

1. **Mechanical core, versioned.** Every signal comes from deterministic, versioned rules. Track records attach to rule versions.
2. **LLM = analyst + interface + veto. Never originator, never risk-sizer.**
3. **A human approves every order.** No exceptions in any phase. Approval places limit orders with TTLs.
4. **The risk engine is law.** It runs after signals and before proposals; its limits are code, not config the LLM can touch.
5. **Broker is the source of truth.** Reconcile before every cycle; freeze on unexplained divergence.
6. **Everything is journaled** — proposals, approvals, rejections, expiries, vetoes, fills, and the market snapshot at each — so the system can be audited and killed on evidence.
7. **Capital is earned in stages.** Shadow → paper → capped live → (maybe) full allocation. Every promotion has a gate; every gate has a kill criterion.

### 2.1 Phase 0 — the reality worksheet (before any code)

Answer in writing, committed to this repo:

| Question | Why it gates everything |
|---|---|
| Dedicated capital for this system (not total account) Answer: $1000| Determines universe: <$25k → ETF wheel + no swing (PDT); $25–50k → 4–6 names, capped; $50k+ → the full design |
| Cash or margin account.   | CSP collateral treatment, PDT exposure |
| Taxable or IRA | Wheel throws off short-term gains; an IRA shelters the churn (see 2.9) |
| Max acceptable drawdown in dollars (write the number) | Becomes the hard halt in the risk engine |
| Minutes per day you'll actually spend | Sizes the approval flow; if the answer is <5, cut the swing module now |

### 2.2 Architecture

```
                 ┌────────────────────────────────────────────┐
                 │              Scheduled cycles               │
                 │  pre-market · 3× intraday · post-close      │
                 └───────────────────┬────────────────────────┘
                                     ▼
┌──────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  Data     │──▶│ Reconciler   │──▶│ Signal engine │──▶│ Risk engine  │
│  layer    │   │ (broker =    │   │ (mechanical,  │   │ (law; sizes, │
│           │   │  truth;      │   │  versioned)   │   │  caps, kills)│
│           │   │  freeze on   │   └──────┬───────┘   └──────┬───────┘
│           │   │  divergence) │          │    candidates     │ sized
└──────────┘   └──────────────┘          ▼                   ▼
                                  ┌──────────────┐   ┌──────────────┐
                                  │ LLM analyst  │──▶│  Proposals   │
                                  │ (rationale,  │   │  (push msg,  │
                                  │  hazard veto,│   │  1-tap, TTL) │
                                  │  brief)      │   └──────┬───────┘
                                  └──────────────┘          │ approved
                                                            ▼
     ┌──────────────┐   ┌──────────────────┐   ┌────────────────────┐
     │   Journal     │◀──│ Broker adapter   │◀──│  Order manager     │
     │ (everything;  │   │ alpaca-paper |   │   │ (limit+TTL, GTC    │
     │  scoreboard)  │   │ schwab-live |    │   │  profit targets,   │
     └──────────────┘   │ manual           │   │  lifecycle state)  │
                        └──────────────────┘   └────────────────────┘
```

**Stack** (keeping your serverless + Supabase preference, with the shape fixed):
- **Supabase (Postgres)** — positions, orders, proposals, journal, rule versions, config. Row-level history on everything (append-only journal table).
- **Scheduled functions** — 5 runs per trading day: pre-market (~8:00 ET, builds brief + new-trade candidates), 3 intraday checks (10:30 / 13:00 / 15:30 ET — roll decisions, delta breaches, ex-div assignment check), post-close (reconcile, journal, mark rule-version P&L). Serverless is fine at this cadence; the tick-speed work lives in broker-side GTC orders, not in your code.
- **Approvals via Telegram bot** (or ntfy.sh push): proposal card with the mechanical reason, the LLM rationale, the size, the limit price, and Approve/Reject buttons. TTL default: end of the run's next hour.
- **Broker adapters:** one interface (`get_positions`, `get_chain`, `place_limit`, `cancel`, `get_fills`), three implementations: `alpaca-paper`, `schwab-live`, `manual` (proposal only; you execute in the Schwab app and the reconciler picks up the fill).
- **LLM layer:** Claude via API. Inputs: candidate list, position list, news/filings/earnings-calendar pulls. Outputs: morning brief, per-candidate rationale + hazard flags (structured: `{flag, severity, source}`), veto recommendations. All logged and scored.

### 2.3 Strategy A — the wheel (the core)

Universe screen (mechanical, run pre-market, all thresholds are v1 rule-version parameters):

- **Liquidity:** options with tight spreads (bid-ask ≤ ~10% of mid on the target strike), open interest ≥ 500, underlying ADV ≥ 1M shares.
- **Price band:** underlying priced so one CSP consumes ≤ 12% of dedicated capital (auto-derived from Phase 0's number).
- **Quality floor:** profitable trailing twelve months OR investment-grade-ish balance sheet proxy (positive FCF, manageable debt); no biotechs pre-approval, no recent-IPO lockups. The floor exists because assignment means *owning it* — only wheel what you'd hold.
- **Catalyst avoidance (this is the risk design from hole #1):** no new short options with an earnings date, ex-div date (for calls), or scheduled binary event inside the expiry window. Hard rule, not a warning.
- **Vol worth selling:** IV rank ≥ 30 on the underlying — otherwise the premium doesn't pay for the tail.

Entry/management rules (v1 parameters, all versioned):
- Sell 30–45 DTE cash-secured puts around 0.20–0.30 delta.
- On fill, **immediately place a GTC buy-to-close at 50% of premium received** (broker-side; this is the tick-speed component).
- Roll or close at 21 DTE if untouched (gamma-risk window).
- If assigned: sell 30–45 DTE covered calls at ≥ 0.20 delta **above cost basis where available**; same 50% GTC close; ex-div early-assignment check in the intraday runs.
- **Single-name loss cap:** if an assigned position falls a threshold % below basis (set in Phase 0, e.g., -20%), the proposal engine proposes the exit — the wheel does not "wheel forever" down a falling knife.

Portfolio rules (risk engine, not strategy config):
- Max 12% of dedicated capital per name; max 25% per sector; minimum cash buffer 10%.
- Max simultaneous short-put notional: 100% of dedicated capital (fully cash-secured, no naked anything, ever).
- **New-trade freeze** when VIX > a set threshold (e.g., 30) or after the drawdown halt trips.

### 2.4 Strategy B — swing module (capped, gated, honest)

- Lives behind the live-forward gate from hole #4: **6 months of shadow-mode signals, logged in real time, must beat SPY-on-the-same-dates after modeled slippage + spread costs.** Backtests are development tools only and never satisfy the gate.
- If it ever passes: capital cap of 20% of the dedicated pool, every trade carries a bracket (entry limit, stop, target) placed as one order (OCO/bracket at the broker), and the module's allocation shrinks automatically after losing months.
- Its real job, per the original insight, is **discipline enforcement** — the bot's value is that the stop actually exists and actually executes. If shadow mode shows no edge after 6 months, delete the module. That outcome is likely and fine; the wheel is the system.

### 2.5 Risk engine (the law)

Hard-coded, ordered checks — a proposal must pass all to exist:
1. Reconciler is green (no unexplained broker divergence).
2. Drawdown halt not tripped (dedicated-pool drawdown from high-water mark < Phase 0's number).
3. Vol-regime freeze not active.
4. Position, sector, cash-buffer, and notional caps satisfied *post-trade*.
5. Catalyst calendar clear for the instrument's window.
6. Order is a limit order with a TTL and (for entries) an attached management plan (GTC target, and stop for swing).

Tripped halts require a **manual, journaled reset** ("I reviewed X, resetting because Y") — friction is the point.

### 2.6 Order lifecycle

`proposed → (approved | rejected | expired) → staged → working → (filled | partial → reconciled | cancelled) → managed → closed`

- Every transition journaled with timestamp + market snapshot.
- Partial fills are reconciled to actual broker quantity before any management order is placed.
- Unapproved proposals expire at TTL and are journaled as expired — the scoreboard tracks what expired proposals *would* have done, which tells you whether your own approval latency is costing money.

### 2.7 The scoreboard (built in Phase 1, before any trading)

Monthly auto-generated report:
- Realized + unrealized P&L of the pool vs. **SPY buy-and-hold on the same capital** (the null hypothesis) — including a rough tax drag adjustment in a taxable account.
- Per-rule-version attribution (so a parameter change starts a new track record).
- Counterfactuals: all-proposals-taken vs. your actual approvals (measures whether your vetoes help), and LLM-vetoes-respected vs. ignored (measures whether *its* vetoes help).
- Costs: spreads paid, assignment friction, and estimated tax drag.

### 2.8 Kill criteria (written now, while nobody's attached to the system)

- **The system:** after 12 live months, if pool P&L (after costs and estimated taxes) trails SPY buy-and-hold by more than a written threshold — wind it down to index funds. The v1 conversation's own evidence (Barber & Odean; the ~1%-of-day-traders-profitable studies) is the prior; the bot must *earn* its rejection of that prior.
- **The swing module:** fails its 6-month shadow gate → deleted, not "iterated until it passes."
- **The LLM's veto power:** no measurable value after 6 months of scoreboard data → demoted to rationale-writer only.
- **Any month the reconciler froze more than twice:** engineering moratorium — no new features until state handling is trustworthy.

### 2.9 Tax notes (taxable account)

V1 §7's tax-lot-aware logging from day one is right — keep it, and add:

- Wheel premium and assignments generate **short-term gains** and can trigger **wash sales** when the wheel re-enters a name it recently exited at a loss (and swing-trading the same names makes wash-sale tracking genuinely painful — one more reason the modules use disjoint universes).
- The scoreboard's SPY benchmark applies a tax-drag estimate for honesty.
- If any of the dedicated pool can live in an IRA, the wheel's churn is dramatically cheaper there. Worth resolving in Phase 0.

---

## Part 3 — Phases and gates

| Phase | What ships | Gate to advance |
|---|---|---|
| **0 — Reality** (1 week) | The worksheet in 2.1, committed to this repo. Broker + data accounts opened (Alpaca paper; Schwab developer app registered). | Numbers written down. |
| **1 — Shadow** (4–6 weeks build, then running) | Data layer, signal engine v1, risk engine, journal, morning brief with proposal cards (no orders anywhere — proposals log what they *would* do). Scoreboard from day one. | 8+ weeks of shadow proposals with sane behavior; scoreboard rendering; you still actually read the brief. |
| **2 — Paper** (running 2–3 months) | Full order lifecycle + reconciler against **Alpaca paper**, incl. assignments, partial fills, GTC management orders, Telegram approvals. | 2–3 months where reconciler stayed green, lifecycle handled ≥1 assignment correctly, and paper wheel P&L behaves as designed (not necessarily beats SPY yet — this gate is *engineering* correctness). |
| **3 — Capped live** (6+ months) | Schwab adapter (or `manual` adapter: bot proposes, you tap the trade into the Schwab app, reconciler ingests the fill). ≤ 50% of the dedicated pool. Weekly ritual: Schwab re-auth + review the scoreboard. | 6 live months, no halt-worthy engineering failures, scoreboard supports continuing. |
| **4 — Full pool / swing decision** | Remaining capital; swing module promoted **only** if its independent 6-month shadow gate passed. | Ongoing: annual kill-criteria review. |

The `manual` adapter is the recommended way to *start* Phase 3: it defers the Schwab OAuth machinery until the system has proven it deserves the integration work, and it costs you ~60 seconds per approved trade.

---

## Part 4 — Explicitly out of scope

- Tick-level or streaming market data. Resting GTC orders at the broker are the fast path.
- Naked options, undefined-risk spreads, futures, crypto.
- Any autonomous (unapproved) order placement, in any phase.
- "Arbitrage." (Per the v1 conversation: real arbitrage is a colocation business, not a software feature.)
- Multi-user anything: no auth systems, no config UIs, no productization. One user, one config file, one Telegram chat.
