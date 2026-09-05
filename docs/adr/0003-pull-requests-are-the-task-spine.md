# Task boundaries come from pull requests, not slash commands

ADR-0001 decided that a Task owns a Slot between boundary events, and named the
slash-command lifecycle (`/start` → `/finish`) as the signal marking them. That
mechanism does not survive contact with the data: the whole corpus contains
**63 `/start` and 68 `/finish` commands** against **332 pull requests into the
integration branch**. Commander's fleet is dispatched programmatically by the
CEO ledger rather than by a human typing a command in each worktree, so the
commands are the rare manual case, not the spine.

The pull request is the durable signal, and it carries the Task identity in its
branch name: `agent/<letter>/<slug>` for a coder and `integrate/<slug>` for the
integrator, which gives Slot and Task together, with GitHub's own `createdAt`
and `mergedAt` as boundaries. So a Task is a PR, and it owns its Slot from the
previous Task's close until its own.

The decision in ADR-0001 is unchanged — the Slot is still the state machine,
and neither the session nor `gitBranch` can serve. Only the boundary signal
changes.

## Consequences

- The silence timeout from ADR-0001 becomes load-bearing rather than a fallback.
  Without it the first Task in each Slot absorbs everything the Slot did before
  the fleet existed: it put a 50-hour, $449 Task at the top of the table.
- Spend splits three ways, and all three are reported rather than one being
  quietly folded into another: attributed to a Task, **orchestration overhead**
  in Slots that never open a PR (CEO and the owner's own console), and
  **between tasks** — work inside a coder Slot that the silence timeout cuts off
  from any Task.
- The CEO ledger holds strictly better data than this reconstruction —
  `taskId`, `briefHash`, `repairCount`, and a direct `prNumber` — but only for
  the batch currently in flight, because it is overwritten. Reconstruction is
  what makes the previous fortnight measurable at all; the ledger watcher is
  what stops the next fortnight needing it.
