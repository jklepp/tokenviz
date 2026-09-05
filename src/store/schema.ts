/**
 * Migrations are append-only: never edit a shipped entry, add a new one.
 * `PRAGMA user_version` tracks how many have been applied.
 */
export const MIGRATIONS: string[] = [
  // 0001 — projects, workflow runs, main commits.
  `
  CREATE TABLE project (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slug         TEXT NOT NULL UNIQUE,
    root_path    TEXT NOT NULL UNIQUE,
    github_repo  TEXT,
    adapter      TEXT,
    created_at   TEXT NOT NULL
  );

  -- Append-only: one row per DISTINCT observed state of a run attempt.
  -- Re-ingesting an unchanged run is a no-op; a run that transitions
  -- (queued -> in_progress -> completed) accumulates one row per state.
  CREATE TABLE workflow_run_observation (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES project(id),
    run_id          INTEGER NOT NULL,
    run_attempt     INTEGER NOT NULL,
    workflow_name   TEXT NOT NULL,
    display_title   TEXT,
    head_branch     TEXT,
    head_sha        TEXT,
    event           TEXT,
    status          TEXT,
    conclusion      TEXT,
    run_started_at  TEXT,
    created_at      TEXT,
    updated_at      TEXT,
    html_url        TEXT,
    observed_at     TEXT NOT NULL
  );

  CREATE UNIQUE INDEX ux_wro_state
    ON workflow_run_observation (project_id, run_id, run_attempt, status, conclusion);
  CREATE INDEX ix_wro_lookup
    ON workflow_run_observation (project_id, workflow_name, event, head_branch);
  CREATE INDEX ix_wro_sha
    ON workflow_run_observation (project_id, head_sha);

  -- Latest known state of every run attempt.
  CREATE VIEW workflow_run AS
    SELECT o.*
      FROM workflow_run_observation o
      JOIN (
        SELECT project_id, run_id, run_attempt, MAX(id) AS max_id
          FROM workflow_run_observation
         GROUP BY project_id, run_id, run_attempt
      ) latest ON o.id = latest.max_id;

  -- Append-only. First-parent history of the default branch.
  CREATE TABLE main_commit (
    project_id     INTEGER NOT NULL REFERENCES project(id),
    sha            TEXT NOT NULL,
    committed_at   TEXT NOT NULL,
    subject        TEXT NOT NULL,
    parent_count   INTEGER NOT NULL,
    first_seen_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, sha)
  );

  CREATE INDEX ix_main_commit_time ON main_commit (project_id, committed_at);

  -- Provenance: what ran, when, and what it found.
  CREATE TABLE ingest_run (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   INTEGER REFERENCES project(id),
    source       TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    seen         INTEGER NOT NULL DEFAULT 0,
    inserted     INTEGER NOT NULL DEFAULT 0,
    error        TEXT
  );
  `,
];
