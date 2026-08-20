# 0dark30

Personal agentic trading platform — wheel-first option income with a gated swing module, human approval on every order, and a scoreboard designed to kill the system if it can't beat doing nothing.

**Start here: [`PLAN.md`](PLAN.md)**
- Part 1 — critique of the original spec ([`docs/v1-spec.md`](docs/v1-spec.md)), ten holes in order of cost
- Part 2 — the v2 design: architecture, strategy rules, risk engine, order lifecycle, scoreboard, kill criteria
- Part 3 — build phases with promotion gates
- Part 4 — explicitly out of scope

**Phase 1 (shadow mode) is built** — see [`docs/PHASE1.md`](docs/PHASE1.md) for the 15-minute setup (Alpaca paper keys → GitHub Actions secrets). Daily cycles screen the universe, run the risk engine, journal every proposal, render the morning brief to `briefs/`, and mark the shadow book against SPY. There is **no execution code** in this phase.

```
npm install
npm test                  # offline unit tests (screener + risk engine)
npm run cycle:premarket   # screen -> risk engine -> brief   (needs Alpaca keys)
npm run cycle:postclose   # mark shadow book, scoreboard row
npm run report            # shadow book vs SPY summary
```

Personal use only. Not financial advice. Nothing trades live until Phase 3's gate is passed.
