# 0dark30

Personal agentic trading platform — wheel-first option income with a gated swing module, human approval on every order, and a scoreboard designed to kill the system if it can't beat doing nothing.

**Start here: [`PLAN.md`](PLAN.md)**
- Part 1 — critique of the original spec ([`docs/v1-spec.md`](docs/v1-spec.md)), ten holes in order of cost
- Part 2 — the v2 design: architecture, strategy rules, risk engine, order lifecycle, scoreboard, kill criteria
- Part 3 — build phases with promotion gates
- Part 4 — explicitly out of scope

**Phase 1 (shadow mode) is live** — daily cycles screen the universe, run the risk engine, journal every proposal, render the morning brief to `docs/briefs/`, mark the shadow book against SPY, and regenerate the dashboard at [`docs/index.html`](docs/index.html). The repo is linked to Vercel (project `0dark30`), which serves `docs/` as a static site and auto-deploys on every cycle's commit — the dashboard URL lives in the Vercel project overview. Setup details: [`docs/PHASE1.md`](docs/PHASE1.md).

**Phase 2 (paper execution) is built and shipped dark** — order lifecycle, reconciler with divergence freeze, and human approvals (Telegram or an `approvals/` file edit) against the Alpaca paper account. It activates with one repository variable when the Phase 1 gate is met: [`docs/PHASE2.md`](docs/PHASE2.md).

```
npm install
npm test                  # offline unit tests (screener + risk engine)
npm run cycle:premarket   # screen -> risk engine -> brief   (needs Alpaca keys)
npm run cycle:postclose   # mark shadow book, scoreboard row
npm run report            # shadow book vs SPY summary
```

Personal use only. Not financial advice. Nothing trades live until Phase 3's gate is passed.
