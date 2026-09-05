import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import type { Project } from '../store/projects.ts';
import { apiPaginate } from '../sources/gh.ts';

type PullPayload = {
  number: number;
  title: string | null;
  state: string;
  created_at: string;
  merged_at: string | null;
  closed_at: string | null;
  head: { ref: string } | null;
  base: { ref: string } | null;
  additions?: number;
  deletions?: number;
};

const PROJECTION =
  '.[] | {number, title, state, created_at, merged_at, closed_at, ' +
  'head: {ref: .head.ref}, base: {ref: .base.ref}}';

/**
 * Append every pull request the repository still exposes.
 *
 * This is universal: it records what GitHub says, with no opinion about what a
 * branch name means. Interpreting `agent/b/some-task` as a slot and a task is
 * the adapter's job, not the store's.
 */
export function ingestPulls(db: DatabaseSync, project: Project): { seen: number; inserted: number } {
  if (!project.github_repo) {
    throw new Error(`project ${project.slug} has no GitHub repo; nothing to ingest`);
  }

  const started = nowIso();
  const ingestId = Number(
    (
      db
        .prepare('INSERT INTO ingest_run (project_id, source, started_at) VALUES (?, ?, ?) RETURNING id')
        .get(project.id, 'pull-requests', started) as { id: number }
    ).id,
  );

  try {
    const pulls = apiPaginate<PullPayload>(
      `repos/${project.github_repo}/pulls?state=all&per_page=100`,
      PROJECTION,
    );

    const insert = db.prepare(
      `INSERT INTO pull_request (
         project_id, number, head_ref, base_ref, title, slot, task_slug,
         state, created_at, merged_at, closed_at, additions, deletions, first_seen_at
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(project_id, number) DO UPDATE SET
         state = excluded.state,
         merged_at = excluded.merged_at,
         closed_at = excluded.closed_at`,
    );

    const seenAt = nowIso();
    let inserted = 0;
    db.exec('BEGIN');
    try {
      for (const p of pulls) {
        const res = insert.run(
          project.id, p.number, p.head?.ref ?? '', p.base?.ref ?? '', p.title,
          p.state, p.created_at, p.merged_at, p.closed_at, seenAt,
        );
        inserted += Number(res.changes);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    db.prepare('UPDATE ingest_run SET finished_at = ?, seen = ?, inserted = ? WHERE id = ?')
      .run(nowIso(), pulls.length, inserted, ingestId);
    return { seen: pulls.length, inserted };
  } catch (err) {
    db.prepare('UPDATE ingest_run SET finished_at = ?, error = ? WHERE id = ?')
      .run(nowIso(), (err as Error).message, ingestId);
    throw err;
  }
}
