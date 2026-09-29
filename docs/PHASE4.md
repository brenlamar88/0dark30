# Phase 4 — swing module (shadow-gated, clock running)

Per PLAN.md 2.4, the swing module is a discipline harness, not a predictor,
and it earns capital only by beating SPY-on-the-same-dates over a 6-month
live-forward shadow window. **The clock starts at its first live signal**
(deployed 2026-09-29). There is no order path for swing trades in any mode —
the gate is structural, not a config flag.

## swing-v1 rules (config/params.v1.json → swing)

- **Entry:** close above the 100-day SMA (uptrend) AND below the 20-day SMA
  (pullback). One position per symbol, ~$5,000 notional.
- **Bracket, set at entry, never moved:** stop = entry − 2× vol-proxy,
  target = entry + 3× vol-proxy, where the vol proxy is the 14-session mean
  absolute close-to-close change (the free feed has no intraday high/low, so
  a close-only ATR stand-in — exits fill at the breaching close, which
  understates real stop slippage; noted so the shadow record is read
  honestly).
- **Time stop:** 20 sessions. No averaging down, no discretionary holds.

## Where it shows up

- New entries and open positions: morning brief, "Swing module" section.
- `data/swing/positions.json`: every position with entry/stop/target/exit.
- Scoreboard: `swing_realized_total` / `swing_open_count` columns; dashboard
  tile.

## The gate (PLAN.md 2.8)

After 6 months of signals: swing realized P&L must beat SPY bought on the
same entry dates after modeled costs, or the module is deleted — not
iterated until it passes. Deletion is a likely and acceptable outcome; the
wheel is the system.
