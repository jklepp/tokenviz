# Cost is API-equivalent, not money paid

Every dollar figure TokenViz reports is modelled: it is what a Task's tokens *would* have
cost at public per-model API rates. The work being measured runs under a Claude subscription,
so no per-request invoice exists — the transcripts record token counts on every request but
a `costUSD` only once per session. We chose the modelled figure over actual spend because
the KPIs that matter here are comparative (p95 versus a trailing baseline, cost per merged
PR, model mix), and under a flat subscription every optimisation would otherwise score as
saving exactly zero.

## Consequences

- Reported totals must never be reconciled against a subscription invoice; they will not
  match, and that is correct. The dashboard states its cost basis prominently for this reason.
- Rates live in **effective-dated rate cards**. A Request is costed by the card in force at
  its timestamp, so a price change produces a visible step rather than silently rewriting
  history. Editing a past card is a deliberate, separate action that re-costs its window and
  reports how much it moved.
- Session-level `cost-state.totalCostUSD` is Claude Code's own billing and is used two ways:
  to seed the initial rate card by solving for effective rates, and thereafter as a
  reconciliation check that warns on drift — which catches both a stale card and a newly
  appeared model.
- Model IDs need normalising before the price join: `claude-opus-5[1m]` is the 1M-context
  tier at different rates from `claude-opus-5`, and dated and undated aliases coexist.
