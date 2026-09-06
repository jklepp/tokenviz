import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../../store/projects.ts';
import { CARD_JOIN, COST_SUM } from '../../pricing/models.ts';

/**
 * Reconstructing Tasks for a Commander fleet.
 *
 * A Task is a unit of agent work with a verifiable outcome. Nothing on disk
 * records one, so it is reconstructed -- and the signal that works is the pull
 * request, not the slash-command lifecycle. See docs/adr/0003 for why.
 *
 * The Slot remains the state machine, exactly as docs/adr/0001 decided: a Task
 * owns its Slot from when the previous Task in that Slot closed until its own
 * PR closes. Because an agent works one Task at a time in a worktree, those
 * windows are contiguous and non-overlapping, which is what makes attributing
 * a request to a Task a matter of "which window is it in".
 */

export type Role = 'Coder' | 'Integrator' | 'CEO' | 'Owner';

/** Six hours: the trough between a long pause and an overnight gap. */
export const SILENCE_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/**
 * Which Slot and Task a branch names.
 *
 * Coders branch as `agent/<letter>/<slug>` while their worktree is `agent<letter>`,
 * so the letter is expanded here rather than left to collide with anything else.
 * The integrator branches as `integrate/<slug>` and works in `integrate`.
 */
export function classifyBranch(headRef: string): { slot: string; taskSlug: string } | null {
  const agent = /^agent\/([a-z])\/(.+)$/.exec(headRef);
  if (agent) return { slot: `agent${agent[1]}`, taskSlug: agent[2]! };
  const integrate = /^integrate\/(.+)$/.exec(headRef);
  if (integrate) return { slot: 'integrate', taskSlug: integrate[1]! };
  return null;
}

/** What a Slot does. Derived from its name; never assigned by hand. */
export function roleOf(slot: string): Role {
  if (/^agent[a-z]$/.test(slot)) return 'Coder';
  if (slot === 'integrate') return 'Integrator';
  if (slot === 'ceo') return 'CEO';
  return 'Owner';
}

/** Fill in the Slot and Task a PR belongs to, for those whose branch says. */
export function annotatePulls(db: DatabaseSync, project: Project): { annotated: number; unmatched: number } {
  const rows = db
    .prepare('SELECT number, head_ref FROM pull_request WHERE project_id = ?')
    .all(project.id) as unknown as { number: number; head_ref: string }[];

  const update = db.prepare('UPDATE pull_request SET slot = ?, task_slug = ? WHERE project_id = ? AND number = ?');
  let annotated = 0;
  let unmatched = 0;

  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const c = classifyBranch(r.head_ref);
      if (!c) {
        unmatched += 1;
        continue;
      }
      update.run(c.slot, c.taskSlug, project.id, r.number);
      annotated += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { annotated, unmatched };
}

export type Task = {
  prNumber: number;
  slot: string;
  role: Role;
  taskSlug: string;
  title: string | null;
  /** merged | closed | open -- the success oracle's raw verdict. */
  outcome: 'landed' | 'abandoned' | 'open';
  windowStart: string | null;
  windowEnd: string;
  createdAt: string;
};

type PullRow = {
  number: number;
  slot: string;
  task_slug: string;
  title: string | null;
  state: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
};

/**
 * Tasks in Slot order, each owning the Slot from the previous Task's close.
 *
 * The first Task in a Slot has no lower bound: everything the Slot did before
 * it belongs to it, because there was no earlier Task to own that work.
 */
export function reconstructTasks(db: DatabaseSync, project: Project, base = 'integration'): Task[] {
  const rows = db
    .prepare(
      `SELECT number, slot, task_slug, title, state, created_at, merged_at, closed_at
         FROM pull_request
        WHERE project_id = ? AND base_ref = ? AND slot IS NOT NULL
        ORDER BY slot, COALESCE(merged_at, closed_at, created_at)`,
    )
    .all(project.id, base) as unknown as PullRow[];

  const tasks: Task[] = [];
  const lastEndBySlot = new Map<string, string>();

  for (const r of rows) {
    const end = r.merged_at ?? r.closed_at;
    const outcome: Task['outcome'] = r.merged_at ? 'landed' : r.closed_at ? 'abandoned' : 'open';
    tasks.push({
      prNumber: r.number,
      slot: r.slot,
      role: roleOf(r.slot),
      taskSlug: r.task_slug,
      title: r.title,
      outcome,
      windowStart: lastEndBySlot.get(r.slot) ?? null,
      windowEnd: end ?? new Date().toISOString(),
      createdAt: r.created_at,
    });
    if (end) lastEndBySlot.set(r.slot, end);
  }

  return tasks;
}

export type TaskMetrics = Task & {
  requests: number;
  sessions: number;
  processed: number;
  cacheRead: number;
  output: number;
  costUSD: number;
  /** Wall-clock from the first request attributed to the Task to its close. */
  durationMs: number | null;
  toolCalls: number;
  toolErrors: number;
  denials: number;
  interrupts: number;
  steers: number;
  /** Any human intervention that invalidates a claim to autonomous success. */
  takeover: boolean;
};

const WINDOW = `r.project_id = ? AND r.slot = ? AND r.ts <= ? AND (? IS NULL OR r.ts > ?)`;

/**
 * Where a Task's work actually began, as opposed to where its window opens.
 *
 * A window runs from the previous Task's close, and the first Task in a Slot
 * has no lower bound at all -- so without this, the first Task in each Slot
 * swallows every request the Slot made before the fleet existed, and any Task
 * that followed a long idle period absorbs that idleness too.
 *
 * The silence timeout is what bounds it: walking back from the Task's close,
 * work stops at the first gap longer than a Slot would plausibly pause for.
 * Requests before that gap belong to no Task, which is the honest answer.
 */
export function effectiveWindowStart(
  db: DatabaseSync,
  project: Project,
  task: Task,
  timeoutMs = SILENCE_TIMEOUT_MS,
): string | null {
  const rows = db
    .prepare(
      `SELECT ts FROM request r WHERE ${WINDOW} ORDER BY r.ts`,
    )
    .all(project.id, task.slot, task.windowEnd, task.windowStart, task.windowStart) as unknown as {
    ts: string;
  }[];
  if (rows.length === 0) return task.windowStart;

  let boundary = task.windowStart;
  for (let i = rows.length - 1; i > 0; i--) {
    const gap = Date.parse(rows[i]!.ts) - Date.parse(rows[i - 1]!.ts);
    if (gap > timeoutMs) {
      // Exclusive lower bound: keep rows[i], drop everything at or before i-1.
      boundary = rows[i - 1]!.ts;
      break;
    }
  }
  return boundary;
}

/** Attribute requests and events to each Task's window. */
export function taskMetrics(db: DatabaseSync, project: Project, tasks: Task[]): TaskMetrics[] {
  const tokenQ = db.prepare(
    `SELECT COUNT(*) requests, COUNT(DISTINCT r.session) sessions,
            COALESCE(SUM(r.input + r.cache_write + r.cache_read + r.output),0) processed,
            COALESCE(SUM(r.cache_read),0) cacheRead,
            COALESCE(SUM(r.output),0) output,
            MIN(r.ts) firstTs
       FROM request r WHERE ${WINDOW}`,
  );
  const costQ = db.prepare(
    `SELECT ${COST_SUM} usd FROM request r ${CARD_JOIN} WHERE ${WINDOW}`,
  );
  const eventQ = db.prepare(
    `SELECT kind, COUNT(*) n FROM session_event r
      WHERE ${WINDOW} GROUP BY kind`,
  );

  return tasks.map((t0) => {
    const start = effectiveWindowStart(db, project, t0);
    const t = { ...t0, windowStart: start };
    const args = [project.id, t.slot, t.windowEnd, start, start];
    const tok = tokenQ.get(...args) as {
      requests: number; sessions: number; processed: number;
      cacheRead: number; output: number; firstTs: string | null;
    };
    const cost = costQ.get(...args) as { usd: number };
    const events = eventQ.all(...args) as unknown as { kind: string; n: number }[];
    const by = (k: string) => events.find((e) => e.kind === k)?.n ?? 0;

    const denials = by('denial');
    const interrupts = by('interrupt');
    const steers = by('steer');

    return {
      ...t,
      requests: tok.requests,
      sessions: tok.sessions,
      processed: tok.processed,
      cacheRead: tok.cacheRead,
      output: tok.output,
      costUSD: cost.usd,
      durationMs: tok.firstTs ? Date.parse(t.windowEnd) - Date.parse(tok.firstTs) : null,
      toolCalls: 0,
      toolErrors: 0,
      denials,
      interrupts,
      steers,
      takeover: denials + interrupts + steers > 0,
    };
  });
}

export type TaskSummary = {
  tasks: number;
  landed: number;
  abandoned: number;
  open: number;
  withTakeover: number;
  /** Landed without any human intervention, over all closed tasks. */
  autonomousSuccessRate: number | null;
  /** Landed at all, over all closed tasks. */
  landRate: number | null;
  totalUSD: number;
  costPerLanded: number | null;
  costPerAutonomousSuccess: number | null;
  p50CostUSD: number | null;
  p95CostUSD: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  /** Spend in Slots that never open a PR: CEO orchestration and the owner. */
  noTaskSlotUSD: number;
  noTaskSlotRequests: number;
  /**
   * Spend inside a Task-bearing Slot that no Task window claims, because the
   * silence timeout cut it off from any Task's work. Exploration between
   * Tasks, and everything a Slot did before its first PR.
   */
  betweenTasksUSD: number;
};

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? null;
}

export function summariseTasks(
  db: DatabaseSync,
  project: Project,
  metrics: TaskMetrics[],
): TaskSummary {
  const closed = metrics.filter((m) => m.outcome !== 'open');
  const landed = metrics.filter((m) => m.outcome === 'landed');
  const autonomous = landed.filter((m) => !m.takeover);
  const totalUSD = metrics.reduce((s, m) => s + m.costUSD, 0);

  const costs = metrics.map((m) => m.costUSD).sort((a, b) => a - b);
  const durations = metrics
    .map((m) => m.durationMs)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);

  // Slots that never open a PR -- CEO orchestration and the owner's own
  // console -- do real work that no Task can claim. Reporting it as
  // unattributed is honest; folding it into a Task would not be.
  const attributed = new Set(metrics.flatMap((m) => [m.slot]));
  const placeholders = [...attributed].map(() => '?').join(',') || "''";
  const un = db
    .prepare(
      `SELECT COUNT(*) n FROM request r WHERE r.project_id = ?
        AND r.slot NOT IN (${placeholders})`,
    )
    .get(project.id, ...attributed) as { n: number };
  const allCosted = db
    .prepare(
      `SELECT ${COST_SUM} usd FROM request r ${CARD_JOIN} WHERE r.project_id = ?`,
    )
    .get(project.id) as { usd: number };
  const unUsd = db
    .prepare(
      `SELECT ${COST_SUM} usd FROM request r ${CARD_JOIN}
        WHERE r.project_id = ? AND r.slot NOT IN (${placeholders})`,
    )
    .get(project.id, ...attributed) as { usd: number };

  return {
    tasks: metrics.length,
    landed: landed.length,
    abandoned: metrics.filter((m) => m.outcome === 'abandoned').length,
    open: metrics.filter((m) => m.outcome === 'open').length,
    withTakeover: metrics.filter((m) => m.takeover).length,
    autonomousSuccessRate: closed.length === 0 ? null : autonomous.length / closed.length,
    landRate: closed.length === 0 ? null : landed.length / closed.length,
    totalUSD,
    costPerLanded: landed.length === 0 ? null : totalUSD / landed.length,
    costPerAutonomousSuccess: autonomous.length === 0 ? null : totalUSD / autonomous.length,
    p50CostUSD: quantile(costs, 0.5),
    p95CostUSD: quantile(costs, 0.95),
    p50DurationMs: quantile(durations, 0.5),
    p95DurationMs: quantile(durations, 0.95),
    noTaskSlotUSD: unUsd.usd,
    noTaskSlotRequests: un.n,
    betweenTasksUSD: allCosted.usd - totalUSD - unUsd.usd,
  };
}
