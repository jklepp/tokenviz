import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../store/projects.ts';

/**
 * Universal-tier reporting: true for any project Claude Code has touched.
 * Nothing here knows about slots, tasks, or workflows.
 */

export type Totals = {
  requests: number;
  sessions: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  thinking: number;
  /** Everything put through a model, cache reads included. */
  processed: number;
  meanContext: number;
  peakContext: number;
  firstDay: string | null;
  lastDay: string | null;
};

const TOTALS_SQL = `
  SELECT COUNT(*)                                        AS requests,
         COUNT(DISTINCT session)                         AS sessions,
         COALESCE(SUM(input), 0)                         AS input,
         COALESCE(SUM(cache_write), 0)                   AS cacheWrite,
         COALESCE(SUM(cache_read), 0)                    AS cacheRead,
         COALESCE(SUM(output), 0)                        AS output,
         COALESCE(SUM(thinking), 0)                      AS thinking,
         COALESCE(SUM(input + cache_write + cache_read + output), 0) AS processed,
         COALESCE(AVG(input + cache_write + cache_read), 0)          AS meanContext,
         COALESCE(MAX(input + cache_write + cache_read), 0)          AS peakContext,
         MIN(day) AS firstDay,
         MAX(day) AS lastDay
    FROM request
   WHERE project_id = ?`;

export function totals(db: DatabaseSync, project: Project): Totals {
  const row = db.prepare(TOTALS_SQL).get(project.id) as Totals;
  return { ...row, meanContext: Math.round(row.meanContext), peakContext: Math.round(row.peakContext) };
}

/**
 * The share of context served from cache.
 *
 * The denominator is context, not processed tokens: output was never a
 * candidate for being cached, so including it would understate the hit rate by
 * a rising amount as a fleet gets chattier.
 */
export function cacheHitRate(t: Totals): number | null {
  const context = t.input + t.cacheWrite + t.cacheRead;
  return context === 0 ? null : t.cacheRead / context;
}

export type ModelRow = {
  model: string | null;
  requests: number;
  processed: number;
  output: number;
  thinking: number;
  cacheRead: number;
};

export function byModel(db: DatabaseSync, project: Project): ModelRow[] {
  return db
    .prepare(
      `SELECT model,
              COUNT(*)                                          AS requests,
              SUM(input + cache_write + cache_read + output)     AS processed,
              SUM(output)                                        AS output,
              SUM(thinking)                                      AS thinking,
              SUM(cache_read)                                    AS cacheRead
         FROM request
        WHERE project_id = ?
        GROUP BY model
        ORDER BY processed DESC`,
    )
    .all(project.id) as unknown as ModelRow[];
}

export type OriginRow = { origin: string; requests: number; processed: number };

export function byOrigin(db: DatabaseSync, project: Project): OriginRow[] {
  return db
    .prepare(
      `SELECT origin, COUNT(*) AS requests, SUM(input + cache_write + cache_read + output) AS processed
         FROM request WHERE project_id = ? GROUP BY origin ORDER BY processed DESC`,
    )
    .all(project.id) as unknown as OriginRow[];
}

export type SlotRow = { slot: string; requests: number; processed: number; sessions: number };

export function bySlot(db: DatabaseSync, project: Project): SlotRow[] {
  return db
    .prepare(
      `SELECT slot, COUNT(*) AS requests, COUNT(DISTINCT session) AS sessions,
              SUM(input + cache_write + cache_read + output) AS processed
         FROM request WHERE project_id = ? GROUP BY slot ORDER BY processed DESC`,
    )
    .all(project.id) as unknown as SlotRow[];
}

export type DayRow = { day: string; requests: number; processed: number };

export function byDay(db: DatabaseSync, project: Project): DayRow[] {
  return db
    .prepare(
      `SELECT day, COUNT(*) AS requests, SUM(input + cache_write + cache_read + output) AS processed
         FROM request WHERE project_id = ? GROUP BY day ORDER BY day`,
    )
    .all(project.id) as unknown as DayRow[];
}

/** Compact magnitudes, matching how the dashboard reads them. */
export function human(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
