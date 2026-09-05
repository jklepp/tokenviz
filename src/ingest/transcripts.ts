import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import type { Project } from '../store/projects.ts';
import {
  discoverTranscripts,
  headHash,
  linesFrom,
  parseCostState,
  parseUsage,
  projectSlug,
  type TranscriptFile,
} from '../sources/transcripts.ts';

export type TranscriptIngestStats = {
  filesSeen: number;
  filesUnchanged: number;
  filesResumed: number;
  filesRescanned: number;
  filesFailed: number;
  discoverySkipped: number;
  linesRead: number;
  requestsInserted: number;
  costStates: number;
};

type FileState = {
  size: number;
  head_hash: string;
  head_len: number;
  mtime_ms: number;
  byte_offset: number;
  rescans: number;
};

/**
 * Ingest every transcript belonging to a project.
 *
 * Dedup is delegated to the primary key on (project_id, message_id): a resumed
 * or forked session re-emits earlier requests, and INSERT OR IGNORE collapses
 * them exactly as a single global Set would, without holding every id in
 * memory. This is why re-parsing a file is always safe -- it can only ever be
 * wasted work, never a double count.
 */
export function ingestTranscripts(db: DatabaseSync, project: Project): TranscriptIngestStats {
  const started = nowIso();
  const ingestId = Number(
    (
      db
        .prepare('INSERT INTO ingest_run (project_id, source, started_at) VALUES (?, ?, ?) RETURNING id')
        .get(project.id, 'transcripts', started) as { id: number }
    ).id,
  );

  const stats: TranscriptIngestStats = {
    filesSeen: 0,
    filesUnchanged: 0,
    filesResumed: 0,
    filesRescanned: 0,
    filesFailed: 0,
    discoverySkipped: 0,
    linesRead: 0,
    requestsInserted: 0,
    costStates: 0,
  };

  try {
    const { files, skipped } = discoverTranscripts(projectSlug(project.root_path));
    stats.filesSeen = files.length;
    stats.discoverySkipped = skipped;

    const readState = db.prepare(
      'SELECT size, head_hash, head_len, mtime_ms, byte_offset, rescans FROM transcript_file WHERE project_id = ? AND path = ?',
    );
    const insertRequest = db.prepare(
      `INSERT OR IGNORE INTO request (
         project_id, message_id, session, slot, origin, model, ts, day,
         input, cache_write, cache_write_5m, cache_write_1h, cache_read,
         output, thinking, iterations, service_tier, cwd, first_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // cost-state is cumulative for its session, so the newest line supersedes
    // any earlier one. This is the one place a later observation replaces an
    // earlier one rather than being appended beside it.
    const upsertSessionCost = db.prepare(
      `INSERT INTO session_cost (
         project_id, session, total_cost_usd, total_api_duration_ms, total_tool_duration_ms,
         total_duration_ms, lines_added, lines_removed, unknown_model_cost, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, session) DO UPDATE SET
         total_cost_usd = excluded.total_cost_usd,
         total_api_duration_ms = excluded.total_api_duration_ms,
         total_tool_duration_ms = excluded.total_tool_duration_ms,
         total_duration_ms = excluded.total_duration_ms,
         lines_added = excluded.lines_added,
         lines_removed = excluded.lines_removed,
         unknown_model_cost = excluded.unknown_model_cost,
         observed_at = excluded.observed_at`,
    );
    const upsertModelCost = db.prepare(
      `INSERT INTO session_model_cost (
         project_id, session, model, input, output, thinking, cache_read, cache_write, cost_usd, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, session, model) DO UPDATE SET
         input = excluded.input, output = excluded.output, thinking = excluded.thinking,
         cache_read = excluded.cache_read, cache_write = excluded.cache_write,
         cost_usd = excluded.cost_usd, observed_at = excluded.observed_at`,
    );
    const saveState = db.prepare(
      `INSERT INTO transcript_file (
         project_id, path, size, head_hash, head_len, mtime_ms, byte_offset, lines_seen, rescans, last_scanned_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, path) DO UPDATE SET
         size = excluded.size, head_hash = excluded.head_hash,
         head_len = excluded.head_len, mtime_ms = excluded.mtime_ms,
         byte_offset = excluded.byte_offset,
         lines_seen = transcript_file.lines_seen + excluded.lines_seen,
         rescans = excluded.rescans, last_scanned_at = excluded.last_scanned_at`,
    );

    db.exec('BEGIN');
    try {
      for (const file of files) {
        try {
          stats.requestsInserted += ingestOne(file, {
            project,
            stats,
            readState,
            insertRequest,
            upsertSessionCost,
            upsertModelCost,
            saveState,
          });
        } catch {
          // One unreadable or corrupt transcript must not blank out the run,
          // but it is counted rather than passing as silence.
          stats.filesFailed += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    db.prepare('UPDATE ingest_run SET finished_at = ?, seen = ?, inserted = ? WHERE id = ?')
      .run(nowIso(), stats.filesSeen, stats.requestsInserted, ingestId);
    return stats;
  } catch (err) {
    db.prepare('UPDATE ingest_run SET finished_at = ?, error = ? WHERE id = ?')
      .run(nowIso(), (err as Error).message, ingestId);
    throw err;
  }
}

type Ctx = {
  project: Project;
  stats: TranscriptIngestStats;
  readState: ReturnType<DatabaseSync['prepare']>;
  insertRequest: ReturnType<DatabaseSync['prepare']>;
  upsertSessionCost: ReturnType<DatabaseSync['prepare']>;
  upsertModelCost: ReturnType<DatabaseSync['prepare']>;
  saveState: ReturnType<DatabaseSync['prepare']>;
};

function ingestOne(file: TranscriptFile, ctx: Ctx): number {
  const { project, stats } = ctx;
  const stat = fs.statSync(file.path);
  const prior = ctx.readState.get(project.id, file.path) as FileState | undefined;

  let startOffset = 0;
  let rescans = prior?.rescans ?? 0;

  if (prior) {
    // Fast path: nothing has touched the file since we last read it.
    if (prior.size === stat.size && prior.mtime_ms === Math.floor(stat.mtimeMs)) {
      stats.filesUnchanged += 1;
      return 0;
    }
    // A file that shrank, or whose head changed, was rewritten rather than
    // appended to -- Claude Code compacts transcripts. Resuming into the
    // middle of a rewritten file would silently skip records, so re-read it
    // whole. Dedup makes that free of double counting.
    // Hash exactly the prefix the stored hash was computed over, so an
    // append cannot masquerade as a rewrite.
    const currentHead = headHash(file.path, prior.head_len);
    if (stat.size < prior.size || currentHead.hash !== prior.head_hash) {
      stats.filesRescanned += 1;
      rescans += 1;
      startOffset = 0;
    } else {
      stats.filesResumed += 1;
      startOffset = prior.byte_offset;
    }
  }

  const observedAt = nowIso();
  let offset = startOffset;
  let lines = 0;
  let inserted = 0;

  for (const { line, nextOffset } of linesFrom(file.path, startOffset)) {
    offset = nextOffset;
    lines += 1;

    const usage = parseUsage(line);
    if (usage) {
      // A record with no id is still one request. Keying it by session and
      // timestamp keeps it countable without letting it dedup against an
      // unrelated request that happens to share an instant.
      const key = usage.messageId ?? `${file.session}#${usage.ts}`;
      const res = ctx.insertRequest.run(
        project.id, key, file.session, file.slot, file.origin, usage.model,
        usage.ts, usage.day, usage.input, usage.cacheWrite, usage.cacheWrite5m,
        usage.cacheWrite1h, usage.cacheRead, usage.output, usage.thinking,
        usage.iterations, usage.serviceTier, usage.cwd, observedAt,
      );
      inserted += Number(res.changes);
      continue;
    }

    const cost = parseCostState(line);
    if (cost) {
      stats.costStates += 1;
      ctx.upsertSessionCost.run(
        project.id, cost.session, cost.totalCostUSD, cost.totalApiDurationMs,
        cost.totalToolDurationMs, cost.totalDurationMs, cost.linesAdded,
        cost.linesRemoved, cost.unknownModelCost ? 1 : 0, observedAt,
      );
      for (const m of cost.models) {
        ctx.upsertModelCost.run(
          project.id, cost.session, m.model, m.input, m.output, m.thinking,
          m.cacheRead, m.cacheWrite, m.costUSD, observedAt,
        );
      }
    }
  }

  stats.linesRead += lines;
  const head = headHash(file.path);
  ctx.saveState.run(
    project.id, file.path, stat.size, head.hash, head.len, Math.floor(stat.mtimeMs),
    offset, lines, rescans, observedAt,
  );
  return inserted;
}
