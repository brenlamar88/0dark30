# Phase 2 runbook — paper execution (built, shipped dark)

Phase 2 code is fully built and **off by default**. In shadow mode (the default)
the midday cycles are no-ops and no order code runs. The plan's own gate
(PLAN.md Part 3) says to run shadow for 8+ weeks first; flipping earlier risks
nothing but money-shaped noise in the record — paper is riskless — but the gate
exists to validate the signals before layering execution data on top. Your
call; the flip is one repository variable.

## Turning Phase 2 on

1. Repo → Settings → Secrets and variables → Actions → **Variables** tab →
   New repository variable: `EXECUTION_MODE` = `paper`.
2. Optional but recommended — Telegram approvals:
   - Message @BotFather on Telegram → `/newbot` → copy the token.
   - Message your new bot once (anything), then open
     `https://api.telegram.org/bot<TOKEN>/getUpdates` and read your
     `chat.id` from the response.
   - Add repo **secrets**: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
3. Optionally reset the Alpaca paper account to $50,000 in the Alpaca
   dashboard so broker buying power matches the simulated pool. The risk
   engine sizes off `config/params.v1.json` regardless.

## What runs once it's on

- **Premarket (8:30 ET):** unchanged screening + risk engine; proposals now
  also go to Telegram (if configured) with their approval short-ids, and the
  brief still lands in `briefs/`.
- **You approve** by either:
  - replying `approve <shortid>` / `reject <shortid>` to the bot, or
  - editing `approvals/YYYY-MM-DD.json` in the repo (GitHub app works from a
    phone): `{"approve": ["ab12cd34"], "reject": []}`.
  Unapproved proposals expire `proposalTtlHours` (6h) after the premarket run
  and are journaled as expired. The shadow book tracks every proposal
  regardless of approval — that's the "all proposals taken" counterfactual
  from PLAN.md 2.7.
- **Midday (10:30 / 13:00 / 15:30 ET):**
  1. Syncs order state from the broker (fills, cancels, expiries → journal).
  2. **Reconciles** — broker positions must be fully explained by our filled
     orders. Any divergence (a manual trade, an assignment, a quantity
     mismatch) freezes new trades and notifies you. Clearing a freeze
     requires `npm run -s cycle -- unfreeze <written reason>` locally or
     deleting `data/state/freeze.json` in a commit whose message says why —
     the friction is the point.
  3. Stages approved entries as **limit day orders at the current mid**
     (re-quoted; if the premium decayed >30% since the proposal it skips
     rather than chases).
  4. Manages open short puts: places the profit-target buy-to-close at 50% of
     entry premium as a **day** limit (Alpaca options don't support GTC, so
     the resting order is re-placed each session — Schwab in Phase 3 has true
     GTC), and closes at the market mid once DTE ≤ 21.
- **Postclose (17:15 ET):** syncs fills, adds paper-book columns
  (`paper_premium_cashflow`, open position count) to the scoreboard next to
  the shadow book and SPY, regenerates the dashboard.

## Order lifecycle guarantees

- Every order is a **limit** order with our UUID as the broker
  `client_order_id`; nothing is ever placed at market.
- One contract per proposal (100-share lots by design).
- The store (`data/orders/orders.json`) plus the journal reconstruct every
  transition: staged → working → filled/cancelled/expired/failed.
- Assignment (shares landing in the account) is **deliberately a freeze** in
  Phase 2 — the covered-call leg of the wheel is Phase 2.5 work, and silent
  share positions are exactly what the reconciler exists to catch.

## Gate to Phase 3 (unchanged, PLAN.md Part 3)

2–3 months of paper where the reconciler stayed green, the lifecycle handled
at least one assignment correctly (that means building the CC leg once the
first assignment freeze fires), and the paper wheel behaved as designed. Plus
the **capital gate from §2.1.1**: pool ≥ $10k (single ETF wheel, half size) or
≥ $25k (full design), on Schwab, with the weekly re-auth ritual.
