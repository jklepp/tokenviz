# TokenViz

TokenViz measures what agentic software development costs. It reads the artifacts that
agent runs already leave on disk — Claude Code transcripts, git history, GitHub state —
and turns them into FinOps and process-health metrics across every project on the machine.

## Language

### Units of work

**Task**:
One unit of agent work with a human-verifiable outcome, normally corresponding to a pull
request. Reconstructed from the slash-command lifecycle recorded in transcripts.
_Avoid_: run, job, ticket, story

**Session**:
One Claude Code conversation, one transcript file, one `sessionId`. A Task spans one or
more Sessions; a Session may touch more than one Task.
_Avoid_: run, conversation, chat, thread

**Subagent Session**:
A Session spawned by another Session, stored as a nested transcript under its parent.
Carries no cost record of its own, so its spend is always derived.
_Avoid_: sidechain, child run

**Request**:
One model API call within a Session, identified by `requestId`. The atomic row of the
token ledger and the grain at which tokens are always known.
_Avoid_: call, turn, step

> **Note on "run".** Commander's `AGENTS.md` uses "run" for what TokenViz calls a Task
> (`idle → active → proposed → landed → idle`), while the dashboard mockup uses "run" for
> what TokenViz calls a Session. Because the word points at two different things in the
> two source systems, TokenViz does not use it at all.

### Where work happens

**Project**:
A repository TokenViz reports on, identified by its main working tree. Its worktrees are
folded into it rather than counted separately.
_Avoid_: repo, workspace, codebase

**Slot**:
A named worktree a Project's agents occupy — in Commander, `agenta`–`agentd`, `integrate`,
and `ceo`. Claude Code keys transcripts by working directory, so Slot is what the raw data
actually records.
_Avoid_: worktree, lane, agent

**Role**:
What a Slot does, derived from its name: Coder, Integrator, CEO, or Owner. The dimension
attribution and chargeback are reported against.
_Avoid_: persona, agent type, fleet role

### Tokens and money

**Processed tokens**:
Every token a Request was billed for — input plus cache write plus cache read plus output.
The denominator for context and volume measures.
_Avoid_: total tokens, gross tokens, throughput

**Cache read**:
Tokens served from a previously cached prefix. Cheap, and normally the overwhelming
majority of Processed tokens.
_Avoid_: cache hit tokens

**Cache write**:
Tokens paid for to establish a cache entry, in either the 5-minute or 1-hour tier.
_Avoid_: cache creation, cache miss tokens

**API-equivalent cost**:
What a Task's tokens would have cost at public per-model API rates. A modeled figure, not
money paid — subscription fees, hardware, and hosting are excluded.
_Avoid_: cost, spend, actual cost

**Price table**:
The versioned per-model rate card used to compute API-equivalent cost. Stamped onto every
ingest so a later price change cannot silently rewrite past numbers.
_Avoid_: pricing config, rates

### Outcomes

**Landed**:
A Task whose pull request merged into the integration branch. The primary success signal,
because GitHub records it durably and retroactively.
_Avoid_: completed, done, shipped, merged

**Takeover**:
Human intervention that invalidates a Task's claim to autonomous success — a denied tool
call, an interrupt, or a substantive typed instruction mid-Task. Short continuations
("yes", "go on") are not Takeovers.
_Avoid_: intervention, handoff, escalation

**Abandoned**:
A Task that never reached its `/finish` before its Slot was reclaimed or went silent. Still
counted in gross cost.
_Avoid_: failed, dropped, stale

**Promotion**:
A release of the integration branch to main. Coarser than Landed and the unit behind
cost-per-deploy.
_Avoid_: deploy, release, ship
