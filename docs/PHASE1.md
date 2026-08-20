# Phase 1 runbook — shadow mode

What this phase is (PLAN.md Part 3): the data layer, mechanical wheel screener,
risk engine, journal, morning brief, and scoreboard — running daily with **no
execution code anywhere**. Proposals are journaled and marked to market so the
rule version builds an auditable track record against the SPY null hypothesis.
Pool: $50,000 **simulated** (PLAN.md §2.1.1).

## Setup (once, ~15 minutes)

1. **Alpaca paper account** (free): sign up at alpaca.markets, open the Paper
   Trading dashboard, generate API keys. Phase 1 uses market data only.
2. Locally: `cp .env.example .env`, fill in `ALPACA_KEY_ID` / `ALPACA_SECRET_KEY`.
3. `npm install`
4. Smoke test: `npm test` (offline), then `npm run cycle:premarket` (hits Alpaca).
5. **For the daily schedule**: add `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY` as
   GitHub Actions secrets (repo Settings → Secrets and variables → Actions).
   The `shadow-cycles` workflow then runs premarket + postclose every weekday
   and commits the journal and brief back to the branch. Without the secrets it
   skips with a warning instead of failing.

Optional:
- `ANTHROPIC_API_KEY` — enables the LLM analyst layer (rationale + hazard
  flags on the brief). Everything works without it; the brief says so when
  it's degraded.
- `FINNHUB_API_KEY` — earnings calendar. Only needed once single names (with
  `hasEarnings: true`) enter `config/universe.json`. A `hasEarnings` symbol
  with no calendar provider is **blocked**, not waved through.
- Supabase mirror: create a project, run `supabase/migrations/0001_init.sql`
  in the SQL editor, set `JOURNAL_BACKEND=supabase` + `SUPABASE_URL` +
  `SUPABASE_SERVICE_ROLE_KEY`. The local JSONL journal stays the Phase 1
  source of record either way.

## Daily outputs

- `briefs/YYYY-MM-DD.html` — the morning brief (proposals, blocked proposals
  with the failing checks, IV rank, risk-engine state).
- `data/journal/YYYY-MM-DD.jsonl` — append-only event log.
- `data/proposals/YYYY-MM-DD.json` — every proposal with full market snapshot,
  checks, and shadow status.
- `data/iv/SYMBOL.jsonl` — daily ATM-IV observations (the IV-rank history,
  building from day 1).
- `data/scoreboard/daily.jsonl` — shadow book vs SPY. `npm run report` prints
  the summary.

## What "shadow" means mechanically

- Premarket screens the universe, sizes candidates through the risk engine
  (open shadow proposals count against the caps, so concentration rules are
  exercised for real), and renders the brief. Proposals are `open` from birth —
  Phase 1 has no approval step because there is nothing to approve into.
- Postclose marks every open proposal at the current option mid and applies
  the mechanical management rules: close at 50% of premium (models the
  broker-side GTC order), manage at 21 DTE, expire at 0.
- The scoreboard accumulates realized/unrealized shadow P&L next to SPY closes.
  It is pre-cost and pre-tax; PLAN.md §2.7's fuller attribution arrives with
  Phase 2 paper fills.

## IV-rank bootstrap

IV rank needs history that doesn't exist on day 1. Until 60 observations
accumulate per symbol (~3 months of runs), the IV-rank threshold is advisory:
candidates carry a "low confidence" tag instead of being gated. The gate
hardens automatically at 60. This is written down here so nobody mistakes
early shadow months for the strategy's real selectivity.

## Known Phase 1 simplifications (by design, revisit in Phase 2)

- VIX freeze is proxied by SPY 20-day realized vol > 30% (no VIX feed on
  Alpaca); parameters in `config/params.v1.json`.
- Shadow fills happen at the mid with no slippage. Real fills are worse; the
  scoreboard therefore flatters the strategy slightly, which is another reason
  Phase 2's gate is engineering correctness, not shadow P&L.
- No ex-div/assignment logic — there are no positions to assign. Arrives in
  Phase 2 with the Alpaca paper order lifecycle and the real reconciler.
- The GitHub Actions cron is UTC and drifts an hour across DST transitions;
  harmless for a premarket/postclose pair.

## Gate to Phase 2 (from PLAN.md Part 3)

8+ weeks of shadow proposals with sane behavior, scoreboard rendering, and the
brief still actually being read. Then: Alpaca paper execution, the full order
lifecycle, reconciler, and Telegram approvals.
