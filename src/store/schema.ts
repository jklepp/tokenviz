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

  // 0002 - transcripts: requests, incremental scan state, cost-state, rate cards.
  `
  -- One row per DEDUPLICATED request. The primary key IS the dedup: a resumed
  -- or forked session re-emits earlier requests, and INSERT OR IGNORE against
  -- (project_id, message_id) collapses them exactly as a single global Set
  -- would, without holding every id in memory.
  CREATE TABLE request (
    project_id      INTEGER NOT NULL REFERENCES project(id),
    message_id      TEXT NOT NULL,
    session         TEXT NOT NULL,
    slot            TEXT NOT NULL,
    origin          TEXT NOT NULL CHECK (origin IN ('console', 'subagent')),
    model           TEXT,
    ts              TEXT NOT NULL,
    day             TEXT NOT NULL,
    input           INTEGER NOT NULL,
    cache_write     INTEGER NOT NULL,
    cache_write_5m  INTEGER NOT NULL,
    cache_write_1h  INTEGER NOT NULL,
    cache_read      INTEGER NOT NULL,
    output          INTEGER NOT NULL,
    thinking        INTEGER NOT NULL,
    iterations      INTEGER NOT NULL,
    service_tier    TEXT,
    cwd             TEXT,
    first_seen_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, message_id)
  ) WITHOUT ROWID;

  CREATE INDEX ix_request_day     ON request (project_id, day);
  CREATE INDEX ix_request_model   ON request (project_id, model);
  CREATE INDEX ix_request_session ON request (project_id, session);
  CREATE INDEX ix_request_slot    ON request (project_id, slot, ts);

  -- Resume state for incremental scanning. head_hash is what makes resuming
  -- safe: Claude Code compacts and rewrites transcripts, and a file that was
  -- rewritten must be re-read from zero rather than resumed into the middle of.
  CREATE TABLE transcript_file (
    project_id       INTEGER NOT NULL REFERENCES project(id),
    path             TEXT NOT NULL,
    size             INTEGER NOT NULL,
    head_hash        TEXT NOT NULL,
    mtime_ms         INTEGER NOT NULL,
    byte_offset      INTEGER NOT NULL,
    lines_seen       INTEGER NOT NULL,
    rescans          INTEGER NOT NULL DEFAULT 0,
    last_scanned_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, path)
  );

  -- Claude Code's own billing, emitted once per session per model. Used to seed
  -- the first rate card and thereafter to reconcile what we compute against it.
  CREATE TABLE session_model_cost (
    project_id   INTEGER NOT NULL REFERENCES project(id),
    session      TEXT NOT NULL,
    model        TEXT NOT NULL,
    input        INTEGER NOT NULL,
    output       INTEGER NOT NULL,
    thinking     INTEGER NOT NULL,
    cache_read   INTEGER NOT NULL,
    cache_write  INTEGER NOT NULL,
    cost_usd     REAL NOT NULL,
    observed_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, session, model)
  );

  CREATE TABLE session_cost (
    project_id              INTEGER NOT NULL REFERENCES project(id),
    session                 TEXT NOT NULL,
    total_cost_usd          REAL,
    total_api_duration_ms   INTEGER,
    total_tool_duration_ms  INTEGER,
    total_duration_ms       INTEGER,
    lines_added             INTEGER,
    lines_removed           INTEGER,
    unknown_model_cost      INTEGER NOT NULL DEFAULT 0,
    observed_at             TEXT NOT NULL,
    PRIMARY KEY (project_id, session)
  );

  -- Effective-dated rates. A request is costed by the card in force at its
  -- timestamp, so a price change is a visible step rather than a silent
  -- rewrite of history. See docs/adr/0002.
  CREATE TABLE rate_card (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    model                TEXT NOT NULL,
    valid_from           TEXT NOT NULL,
    input_per_mtok       REAL NOT NULL,
    output_per_mtok      REAL NOT NULL,
    cache_write_5m_per_mtok REAL NOT NULL,
    cache_write_1h_per_mtok REAL NOT NULL,
    cache_read_per_mtok  REAL NOT NULL,
    source               TEXT NOT NULL,
    note                 TEXT,
    created_at           TEXT NOT NULL,
    UNIQUE (model, valid_from)
  );
  `,

  // 0003 - head_len: the prefix length head_hash was computed over.
  // Without it, "hash whatever fits in 4 KiB" makes every append to a file
  // under 4 KiB look like a rewrite. Existing scan state is cleared so the
  // next run re-establishes it consistently; that costs one full re-read and
  // cannot double count, because dedup is on the request primary key.
  `
  ALTER TABLE transcript_file ADD COLUMN head_len INTEGER NOT NULL DEFAULT 0;
  DELETE FROM transcript_file;
  `,
];
