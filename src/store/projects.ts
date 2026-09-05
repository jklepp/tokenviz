import type { DatabaseSync } from 'node:sqlite';
import { basename, resolve } from 'node:path';
import { nowIso } from './db.ts';

export type Project = {
  id: number;
  slug: string;
  root_path: string;
  github_repo: string | null;
  adapter: string | null;
};

/**
 * Registration is idempotent and keyed on the resolved root path.
 * Re-registering fills in a github_repo or adapter that was previously unknown,
 * but never overwrites one that is already set.
 */
export function registerProject(
  db: DatabaseSync,
  opts: { rootPath: string; slug?: string; githubRepo?: string | null; adapter?: string | null },
): Project {
  const rootPath = resolve(opts.rootPath);
  const slug = opts.slug ?? basename(rootPath).toLowerCase();

  db.prepare(
    `INSERT INTO project (slug, root_path, github_repo, adapter, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(root_path) DO UPDATE SET
       github_repo = COALESCE(project.github_repo, excluded.github_repo),
       adapter     = COALESCE(project.adapter, excluded.adapter)`,
  ).run(slug, rootPath, opts.githubRepo ?? null, opts.adapter ?? null, nowIso());

  return getProjectByPath(db, rootPath)!;
}

export function getProjectByPath(db: DatabaseSync, rootPath: string): Project | null {
  return (db
    .prepare('SELECT id, slug, root_path, github_repo, adapter FROM project WHERE root_path = ?')
    .get(resolve(rootPath)) as Project | undefined) ?? null;
}

export function listProjects(db: DatabaseSync): Project[] {
  return db
    .prepare('SELECT id, slug, root_path, github_repo, adapter FROM project ORDER BY slug')
    .all() as unknown as Project[];
}
