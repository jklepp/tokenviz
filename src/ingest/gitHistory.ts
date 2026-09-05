import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import type { Project } from '../store/projects.ts';
import { defaultBranch, firstParentHistory } from '../sources/git.ts';

/**
 * Append the first-parent history of the default branch. Rewriting history
 * upstream would orphan rows rather than mutate them, which is the intended
 * trade: the store records what was true when we looked.
 */
export function ingestGitHistory(
  db: DatabaseSync,
  project: Project,
): { seen: number; inserted: number; branch: string } {
  const started = nowIso();
  const ingestId = Number(
    (
      db
        .prepare('INSERT INTO ingest_run (project_id, source, started_at) VALUES (?, ?, ?) RETURNING id')
        .get(project.id, 'git-first-parent', started) as { id: number }
    ).id,
  );

  try {
    const branch = defaultBranch(project.root_path);
    const commits = firstParentHistory(project.root_path, branch);

    const insert = db.prepare(
      `INSERT OR IGNORE INTO main_commit
         (project_id, sha, committed_at, subject, parent_count, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const seenAt = nowIso();
    let inserted = 0;

    db.exec('BEGIN');
    try {
      for (const c of commits) {
        const res = insert.run(project.id, c.sha, c.committedAt, c.subject, c.parentCount, seenAt);
        inserted += Number(res.changes);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    db.prepare('UPDATE ingest_run SET finished_at = ?, seen = ?, inserted = ? WHERE id = ?')
      .run(nowIso(), commits.length, inserted, ingestId);

    return { seen: commits.length, inserted, branch };
  } catch (err) {
    db.prepare('UPDATE ingest_run SET finished_at = ?, error = ? WHERE id = ?')
      .run(nowIso(), (err as Error).message, ingestId);
    throw err;
  }
}
