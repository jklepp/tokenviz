import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import type { Project } from '../store/projects.ts';
import { apiPaginate } from '../sources/gh.ts';

type RunPayload = {
  id: number;
  run_attempt: number;
  name: string;
  display_title: string | null;
  head_branch: string | null;
  head_sha: string | null;
  event: string | null;
  status: string | null;
  conclusion: string | null;
  run_started_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  html_url: string | null;
};

const PROJECTION =
  '.workflow_runs[] | {id, run_attempt, name, display_title, head_branch, head_sha, ' +
  'event, status, conclusion, run_started_at, created_at, updated_at, html_url}';

/**
 * Append every Actions run we can still see.
 *
 * GitHub does not keep run history forever, so the point of this is that once a
 * run has been observed it belongs to the local store permanently. Writes are
 * INSERT OR IGNORE against a uniqueness constraint on the run's *state*, so
 * re-ingesting is free and a run that later changes state appends a new row
 * rather than overwriting the old one.
 */
export function ingestActions(db: DatabaseSync, project: Project): { seen: number; inserted: number } {
  if (!project.github_repo) {
    throw new Error(`project ${project.slug} has no GitHub repo; nothing to ingest`);
  }

  const started = nowIso();
  const ingestId = Number(
    (
      db
        .prepare('INSERT INTO ingest_run (project_id, source, started_at) VALUES (?, ?, ?) RETURNING id')
        .get(project.id, 'github-actions', started) as { id: number }
    ).id,
  );

  try {
    const runs = apiPaginate<RunPayload>(
      `repos/${project.github_repo}/actions/runs?per_page=100`,
      PROJECTION,
    );

    const insert = db.prepare(
      `INSERT OR IGNORE INTO workflow_run_observation (
         project_id, run_id, run_attempt, workflow_name, display_title, head_branch,
         head_sha, event, status, conclusion, run_started_at, created_at, updated_at,
         html_url, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const observedAt = nowIso();
    let inserted = 0;

    db.exec('BEGIN');
    try {
      for (const r of runs) {
        const res = insert.run(
          project.id, r.id, r.run_attempt, r.name, r.display_title, r.head_branch,
          r.head_sha, r.event, r.status, r.conclusion, r.run_started_at, r.created_at,
          r.updated_at, r.html_url, observedAt,
        );
        inserted += Number(res.changes);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    db.prepare('UPDATE ingest_run SET finished_at = ?, seen = ?, inserted = ? WHERE id = ?')
      .run(nowIso(), runs.length, inserted, ingestId);

    return { seen: runs.length, inserted };
  } catch (err) {
    db.prepare('UPDATE ingest_run SET finished_at = ?, error = ? WHERE id = ?')
      .run(nowIso(), (err as Error).message, ingestId);
    throw err;
  }
}
