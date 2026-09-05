# Tasks are reconstructed from Slot occupancy, not from sessions or branches

TokenViz needs a Task — a unit of agent work with a verifiable outcome — but nothing on
disk records one. The obvious keys both fail: a Session is the wrong grain (one Session
can cover several Tasks, and one Task routinely spans several Sessions across worktrees),
and branch attribution is unusable because `gitBranch` is recorded as `"HEAD"` in
Commander's detached worktrees. What *is* reliably recorded is the slash-command lifecycle
(`/start → /pr → /integrate → /finish`, 1,147 entries in the corpus) and the working
directory of every request. So a Task is defined as **the span during which it occupies a
Slot**: it begins at `/start` and ends at whichever comes first — its `/finish`, the next
`/start` in that Slot, or a 6-hour silence timeout.

## Consequences

- Resumed and forked Sessions stitch into their Task automatically, because continuity is
  established by Slot and time rather than by `sessionId`.
- An unclosed Task is self-terminating rather than unbounded; it gets status `abandoned`
  and stays in the gross-cost denominator.
- Task boundaries are a **derived, re-computable** property of the ingested data. Changing
  the timeout re-derives history rather than corrupting it.
- The 6-hour timeout is a starting value, to be validated against the observed
  distribution of inter-request gaps per Slot.
