import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../../store/db.ts';
import type { Project } from '../../store/projects.ts';

/**
 * Capturing Commander's CEO ledger from outside.
 *
 * The ledger is the best task record that exists -- taskId, briefHash, phase,
 * repairCount, dispatch outcomes, and a direct prNumber -- and it is rewritten
 * in place on every transition, keeping only the batch in flight. Everything
 * about every finished batch is already gone.
 *
 * Reading a file is not a change to Commander, so this needs no cooperation
 * from it: poll, and append each revision that is new. What is lost is lost,
 * but nothing more is.
 */

export function ledgerPath(project: Project): string {
  return path.join(project.root_path, '.git', 'agentctl', 'ceo-ledger.json');
}

type LedgerTask = {
  taskId?: string;
  title?: string;
  briefHash?: string;
  phase?: string;
  repairCount?: number;
  prNumber?: number;
  dispatches?: unknown[];
  createdAt?: string;
  updatedAt?: string;
};

type Ledger = {
  schemaVersion?: number;
  rev?: number;
  batch?: { batchId?: string; tasks?: Record<string, LedgerTask> };
};

export type CaptureResult =
  | { status: 'missing' }
  | { status: 'unchanged'; rev: number }
  | { status: 'captured'; rev: number; batchId: string | null; tasks: number };

/** Record the ledger's current revision, if we have not seen it already. */
export function captureLedger(db: DatabaseSync, project: Project): CaptureResult {
  const file = ledgerPath(project);
  if (!fs.existsSync(file)) return { status: 'missing' };

  let body: string;
  let parsed: Ledger;
  try {
    body = fs.readFileSync(file, 'utf8');
    parsed = JSON.parse(body) as Ledger;
  } catch {
    // A read that lands mid-write is expected while the fleet is running.
    // Skipping is correct: the next poll sees a complete file.
    return { status: 'missing' };
  }

  const rev = typeof parsed.rev === 'number' ? parsed.rev : -1;
  if (rev < 0) return { status: 'missing' };

  const seen = db
    .prepare('SELECT 1 FROM ledger_revision WHERE project_id = ? AND rev = ?')
    .get(project.id, rev);
  if (seen) return { status: 'unchanged', rev };

  const batchId = parsed.batch?.batchId ?? null;
  const tasks = Object.values(parsed.batch?.tasks ?? {});

  db.exec('BEGIN');
  try {
    db.prepare(
      'INSERT OR IGNORE INTO ledger_revision (project_id, rev, batch_id, observed_at, body) VALUES (?, ?, ?, ?, ?)',
    ).run(project.id, rev, batchId, nowIso(), body);

    if (batchId) {
      const upsert = db.prepare(
        `INSERT INTO ledger_task (
           project_id, batch_id, task_id, title, brief_hash, phase, repair_count,
           pr_number, dispatches, created_at, updated_at, last_rev
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, batch_id, task_id) DO UPDATE SET
           title = excluded.title, brief_hash = excluded.brief_hash,
           phase = excluded.phase, repair_count = excluded.repair_count,
           pr_number = excluded.pr_number, dispatches = excluded.dispatches,
           updated_at = excluded.updated_at, last_rev = excluded.last_rev`,
      );
      for (const t of tasks) {
        if (!t.taskId) continue;
        upsert.run(
          project.id, batchId, t.taskId, t.title ?? null, t.briefHash ?? null,
          t.phase ?? null, t.repairCount ?? null, t.prNumber ?? null,
          JSON.stringify(t.dispatches ?? []), t.createdAt ?? null, t.updatedAt ?? null, rev,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { status: 'captured', rev, batchId, tasks: tasks.length };
}

export type LedgerStats = {
  revisions: number;
  batches: number;
  tasks: number;
  repaired: number;
  withPr: number;
};

export function ledgerStats(db: DatabaseSync, project: Project): LedgerStats {
  const r = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM ledger_revision WHERE project_id = ?)                    revisions,
              (SELECT COUNT(DISTINCT batch_id) FROM ledger_task WHERE project_id = ?)        batches,
              (SELECT COUNT(*) FROM ledger_task WHERE project_id = ?)                        tasks,
              (SELECT COUNT(*) FROM ledger_task WHERE project_id = ? AND repair_count > 0)   repaired,
              (SELECT COUNT(*) FROM ledger_task WHERE project_id = ? AND pr_number IS NOT NULL) withPr`,
    )
    .get(project.id, project.id, project.id, project.id, project.id) as LedgerStats;
  return r;
}
