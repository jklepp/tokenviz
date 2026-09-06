import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../store/projects.ts';
import { costSummary, listCards, reconcile, type Card } from '../pricing/cost.ts';
import { CARD_JOIN, COST_SUM } from '../pricing/models.ts';
import { byDay, byModel, bySlot, cacheHitRate, totals, type Totals } from './usage.ts';
import {
  reconstructTasks,
  roleOf,
  summariseTasks,
  taskMetrics,
  type TaskMetrics,
  type TaskSummary,
} from '../adapters/commander/tasks.ts';

/**
 * Assembling what a dashboard needs.
 *
 * The universal half is true of any project Claude Code has touched. The
 * Commander half exists only where a project has an adapter and pull requests
 * that name a slot, and its absence is a normal state, not an error.
 */

export type DayPoint = { day: string; processed: number; requests: number; usd: number };

export type ModelRow = {
  model: string | null;
  requests: number;
  processed: number;
  output: number;
  usd: number;
  priced: boolean;
  contextWindow: number | null;
  peakContext: number;
};

export type SlotRow = {
  slot: string;
  /** Null unless the project has an adapter that gives slots a meaning. */
  role: string | null;
  requests: number;
  processed: number;
  usd: number;
};

export type Dashboard = {
  project: Project;
  totals: Totals;
  cacheHitRate: number | null;
  costUSD: number;
  uncostedRequests: number;
  cardsPresent: boolean;
  days: DayPoint[];
  models: ModelRow[];
  slots: SlotRow[];
  reconciliation: { computed: number; billed: number; medianRelError: number } | null;
  commander: {
    summary: TaskSummary;
    tasks: TaskMetrics[];
    roles: { role: string; tasks: number; landed: number; takeovers: number; usd: number }[];
  } | null;
};


export function buildDashboard(db: DatabaseSync, project: Project): Dashboard {
  const t = totals(db, project);
  const cards = listCards(db);
  const cost = cards.length > 0 ? costSummary(db, project) : null;

  const dayUsd = new Map<string, number>();
  if (cards.length > 0) {
    for (const r of db
      .prepare(
        `SELECT r.day, ${COST_SUM} usd FROM request r ${CARD_JOIN}
          WHERE r.project_id = ? GROUP BY r.day`,
      )
      .all(project.id) as unknown as { day: string; usd: number }[]) {
      dayUsd.set(r.day, r.usd);
    }
  }
  const days: DayPoint[] = byDay(db, project).map((d) => ({
    day: d.day,
    processed: d.processed,
    requests: d.requests,
    usd: dayUsd.get(d.day) ?? 0,
  }));

  const modelUsd = new Map<string, number>();
  if (cards.length > 0) {
    for (const r of db
      .prepare(
        `SELECT r.model, ${COST_SUM} usd FROM request r ${CARD_JOIN}
          WHERE r.project_id = ? GROUP BY r.model`,
      )
      .all(project.id) as unknown as { model: string; usd: number }[]) {
      modelUsd.set(r.model, r.usd);
    }
  }
  const windows = new Map(
    (
      db.prepare('SELECT model, context_window FROM model_setting').all() as unknown as {
        model: string;
        context_window: number | null;
      }[]
    ).map((r) => [r.model, r.context_window]),
  );
  const peaks = new Map(
    (
      db
        .prepare(
          `SELECT model, MAX(input + cache_write + cache_read) peak FROM request
            WHERE project_id = ? GROUP BY model`,
        )
        .all(project.id) as unknown as { model: string; peak: number }[]
    ).map((r) => [r.model, r.peak]),
  );

  const models: ModelRow[] = byModel(db, project).map((m) => ({
    model: m.model,
    requests: m.requests,
    processed: m.processed,
    output: m.output,
    usd: modelUsd.get(m.model ?? '') ?? 0,
    priced: modelUsd.has(m.model ?? ''),
    contextWindow: windows.get(m.model ?? '') ?? null,
    peakContext: peaks.get(m.model ?? '') ?? 0,
  }));

  const slotUsd = new Map<string, number>();
  if (cards.length > 0) {
    for (const r of db
      .prepare(
        `SELECT r.slot, ${COST_SUM} usd FROM request r ${CARD_JOIN}
          WHERE r.project_id = ? GROUP BY r.slot`,
      )
      .all(project.id) as unknown as { slot: string; usd: number }[]) {
      slotUsd.set(r.slot, r.usd);
    }
  }
  // Role is a Commander concept. A project without that adapter has worktrees
  // named whatever its author called them, and labelling them all "Owner"
  // would be inventing structure that is not there.
  const hasRoles = project.adapter === 'commander';
  const slots: SlotRow[] = bySlot(db, project).map((s) => ({
    slot: s.slot,
    role: hasRoles ? roleOf(s.slot) : null,
    requests: s.requests,
    processed: s.processed,
    usd: slotUsd.get(s.slot) ?? 0,
  }));

  let commander: Dashboard['commander'] = null;
  if (project.adapter === 'commander' && cards.length > 0) {
    const tasks = reconstructTasks(db, project);
    if (tasks.length > 0) {
      const metrics = taskMetrics(db, project, tasks);
      const summary = summariseTasks(db, project, metrics);
      const roleMap = new Map<string, { role: string; tasks: number; landed: number; takeovers: number; usd: number }>();
      for (const m of metrics) {
        const r = roleMap.get(m.role) ?? { role: m.role, tasks: 0, landed: 0, takeovers: 0, usd: 0 };
        r.tasks += 1;
        if (m.outcome === 'landed') r.landed += 1;
        if (m.takeover) r.takeovers += 1;
        r.usd += m.costUSD;
        roleMap.set(m.role, r);
      }
      commander = {
        summary,
        tasks: [...metrics].sort((a, b) => b.costUSD - a.costUSD),
        roles: [...roleMap.values()].sort((a, b) => b.usd - a.usd),
      };
    }
  }

  const rec = cards.length > 0 ? reconcile(db, project) : null;

  return {
    project,
    totals: t,
    cacheHitRate: cacheHitRate(t),
    costUSD: cost?.totalUSD ?? 0,
    uncostedRequests: cost?.uncostedRequests ?? t.requests,
    cardsPresent: cards.length > 0,
    days,
    models,
    slots,
    // A project whose transcripts carry no cost-state has nothing to reconcile
    // against; reporting NaN would read as a broken number rather than a gap.
    reconciliation:
      rec && rec.sessions > 0
        ? { computed: rec.computedUSD, billed: rec.billedUSD, medianRelError: rec.medianRelError }
        : null,
    commander,
  };
}

export type SettingsView = {
  project: Project;
  cards: Card[];
  windows: Map<string, number | null>;
  aliases: { request_model: string; card_model: string; reason: string | null }[];
  unpriced: string[];
};

export function buildSettings(db: DatabaseSync, project: Project): SettingsView {
  const cards = listCards(db);
  const cardModels = new Set(cards.map((c) => c.model));
  const aliases = db
    .prepare('SELECT request_model, card_model, reason FROM model_alias ORDER BY request_model')
    .all() as unknown as { request_model: string; card_model: string; reason: string | null }[];
  const aliased = new Set(aliases.map((a) => a.request_model));

  const seen = db
    .prepare('SELECT DISTINCT model FROM request WHERE project_id = ? AND model IS NOT NULL ORDER BY model')
    .all(project.id) as unknown as { model: string }[];

  return {
    project,
    cards,
    windows: new Map(
      (
        db.prepare('SELECT model, context_window FROM model_setting').all() as unknown as {
          model: string;
          context_window: number | null;
        }[]
      ).map((r) => [r.model, r.context_window]),
    ),
    aliases,
    unpriced: seen.map((s) => s.model).filter((m) => !cardModels.has(m) && !aliased.has(m)),
  };
}
