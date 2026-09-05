import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reading Claude Code transcripts.
 *
 * Ported from Commander's `scripts/agent/usage.ts`, which is the only version
 * validated against this corpus. Its hard-won correctness notes carry over,
 * because each one is a way a naive read silently produces a wrong number
 * rather than an error.
 */

export type Origin = 'console' | 'subagent';

export function projectsRoot(): string {
  return process.env.TOKENVIZ_PROJECTS_ROOT ?? path.join(os.homedir(), '.claude', 'projects');
}

/**
 * The directory Claude Code writes a project's transcripts to. Every character
 * that separates path segments -- drive colon, both slashes, and the dot of
 * `.claude` -- becomes a hyphen, so `C:\AI\Commander` is `C--AI-Commander`.
 *
 * This direction is exact. The inverse is not: `C--AI-Secapp-GRC` could decode
 * to `C:\AI\Secapp\GRC` or `C:\AI\Secapp-GRC`. TokenViz therefore always slugs
 * forward from a registered root path and never parses a directory name.
 */
export function projectSlug(absolutePath: string): string {
  return absolutePath.replace(/[\\/:.]/g, '-');
}

/** How `.claude/worktrees/` slugs, between the checkout and the slot's name. */
const WORKTREE_MARKER = '--claude-worktrees-';

/**
 * Whether a project directory belongs to this project: the checkout itself, or
 * one of the worktrees under its `.claude/worktrees/`.
 *
 * The whole marker is load-bearing, not just a hyphen. A bare `rootSlug + "-"`
 * prefix admits `C--AI-CommanderTwo` -- a different repository whose tokens
 * would be billed here -- and still admits `C:/AI/Commander-Two`, which slugs
 * to `C--AI-Commander-Two`. Requiring the worktree path separates a sibling
 * checkout from a slot.
 */
export function isProjectDir(directory: string, rootSlug: string): boolean {
  return directory === rootSlug || directory.startsWith(`${rootSlug}${WORKTREE_MARKER}`);
}

/** Which slot a project directory is. The main checkout is `main`. */
export function slotOf(directory: string, rootSlug: string): string {
  if (directory === rootSlug) return 'main';
  return directory.slice(rootSlug.length + WORKTREE_MARKER.length).toLowerCase();
}

export type TranscriptFile = {
  path: string;
  slot: string;
  session: string;
  origin: Origin;
};

/**
 * Every transcript belonging to a project: each slot's own top-level files,
 * plus everything nested beneath a session's directory at any depth, which is
 * where reviewers and subagents write.
 *
 * Reading only the top level undercounts a busy day by the whole reviewer
 * fleet -- Commander measured roughly 30%. A nested transcript bills the slot
 * its console sits under, never a slot of its own, and is identified by its
 * path relative to the project directory: a bare filename collides across
 * sessions, a relative path cannot.
 */
export function discoverTranscripts(
  rootSlug: string,
  root = projectsRoot(),
): { files: TranscriptFile[]; skipped: number } {
  const files: TranscriptFile[] = [];
  let skipped = 0;
  if (!fs.existsSync(root)) return { files, skipped };

  for (const directory of fs.readdirSync(root)) {
    if (!isProjectDir(directory, rootSlug)) continue;
    const directoryPath = path.join(root, directory);
    let isDir = false;
    try {
      isDir = fs.statSync(directoryPath).isDirectory();
    } catch {
      skipped += 1;
      continue;
    }
    if (!isDir) continue;

    const slot = slotOf(directory, rootSlug);
    for (const entry of fs.readdirSync(directoryPath)) {
      const full = path.join(directoryPath, entry);
      if (entry.endsWith('.jsonl')) {
        files.push({ path: full, slot, session: entry.slice(0, -6), origin: 'console' });
        continue;
      }
      let entryIsDir = false;
      try {
        entryIsDir = fs.statSync(full).isDirectory();
      } catch {
        skipped += 1;
        continue;
      }
      if (!entryIsDir) continue;
      const nested = walkNested(full, directoryPath, slot);
      files.push(...nested.files);
      skipped += nested.skipped;
    }
  }
  return { files, skipped };
}

function walkNested(dir: string, projectDirectory: string, slot: string) {
  const files: TranscriptFile[] = [];
  let skipped = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // The directory itself, not one file in it -- still one thing we could not
    // see into, so it is counted rather than passing as silence.
    return { files, skipped: 1 };
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (entry.endsWith('.jsonl')) {
      const session = path.relative(projectDirectory, full).split(path.sep).join('/').slice(0, -6);
      files.push({ path: full, slot, session, origin: 'subagent' });
      continue;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(full).isDirectory();
    } catch {
      skipped += 1;
      continue;
    }
    if (!isDir) continue;
    const deeper = walkNested(full, projectDirectory, slot);
    files.push(...deeper.files);
    skipped += deeper.skipped;
  }
  return { files, skipped };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export type UsageRecord = {
  /**
   * `message.id`, the only field that identifies a request across resumes.
   * Null when the transcript carried neither it nor a `requestId`; the caller
   * supplies a session-scoped key in that case, because a bare timestamp would
   * let two unrelated requests in different sessions dedup against each other.
   */
  messageId: string | null;
  ts: string;
  day: string;
  model: string | null;
  cwd: string | null;
  input: number;
  cacheWrite: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  thinking: number;
  iterations: number;
  serviceTier: string | null;
};

/**
 * One transcript line to one usage record, or null for the many lines that
 * carry none.
 *
 * The `includes` guard is not a micro-optimisation: the corpus runs to
 * gigabytes, and parsing every line as JSON to discard most of them is the
 * difference between this being usable and not.
 */
export function parseUsage(line: string): UsageRecord | null {
  if (!line.includes('"usage"')) return null;
  let entry: {
    timestamp?: unknown;
    requestId?: unknown;
    cwd?: unknown;
    message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  const usage = entry.message?.usage;
  const timestamp = entry.timestamp;
  if (!usage || typeof timestamp !== 'string') return null;
  if (!Number.isFinite(Date.parse(timestamp))) return null;

  const id = entry.message?.id ?? entry.requestId;
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const details = usage.output_tokens_details as Record<string, unknown> | undefined;
  const iterations = usage.iterations;

  return {
    messageId: typeof id === 'string' && id !== '' ? id : null,
    ts: timestamp,
    day: timestamp.slice(0, 10),
    model: typeof entry.message?.model === 'string' ? entry.message.model : null,
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
    input: num(usage.input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens),
    cacheWrite5m: num(creation?.ephemeral_5m_input_tokens),
    cacheWrite1h: num(creation?.ephemeral_1h_input_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    output: num(usage.output_tokens),
    thinking: num(details?.thinking_tokens),
    iterations: Array.isArray(iterations) ? iterations.length : 0,
    serviceTier: typeof usage.service_tier === 'string' ? usage.service_tier : null,
  };
}

export type EventKind = 'command' | 'denial' | 'interrupt' | 'steer';

export type SessionEvent = {
  uuid: string;
  ts: string;
  kind: EventKind;
  detail: string | null;
  /** Characters typed, for a steer; otherwise null. */
  size: number | null;
};

const COMMAND_RE = /<command-name>([^<]+)<\/command-name>/;

/**
 * Things that happened in a session which are not model requests.
 *
 * `steer` is the load-bearing one and the least certain: it is a human typing
 * mid-run, which is a takeover only when it is substantive. "yes" and "go on"
 * are not takeovers, so a length threshold separates steering from assent.
 * The threshold is a judgement call and is therefore a parameter, not a
 * constant buried in here.
 */
export function parseEvent(line: string, steerMinChars = 100): SessionEvent | null {
  if (!line.includes('"user"')) return null;
  let entry: {
    type?: unknown;
    uuid?: unknown;
    timestamp?: unknown;
    toolDenialKind?: unknown;
    interruptedMessageId?: unknown;
    isMeta?: unknown;
    sourceToolUseID?: unknown;
    message?: { role?: unknown; content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    return null;
  }
  if (entry.type !== 'user') return null;
  if (typeof entry.uuid !== 'string' || typeof entry.timestamp !== 'string') return null;

  const base = { uuid: entry.uuid, ts: entry.timestamp };

  // Most user-role lines are not a human typing. Skill re-invocations, system
  // reminders and hook output all arrive as `user` with string content and are
  // marked `isMeta`; anything carrying a `sourceToolUseID` came back from a
  // tool. Counting these as human intervention put a takeover on 95% of tasks.
  const machineOrigin = entry.isMeta === true || typeof entry.sourceToolUseID === 'string';

  if (typeof entry.toolDenialKind === 'string') {
    return { ...base, kind: 'denial', detail: entry.toolDenialKind, size: null };
  }
  if (typeof entry.interruptedMessageId === 'string') {
    return { ...base, kind: 'interrupt', detail: null, size: null };
  }

  // Only a string content is something a human typed. An array is tool
  // results and other machinery coming back into the conversation.
  const content = entry.message?.content;
  if (typeof content !== 'string') return null;

  const command = COMMAND_RE.exec(content);
  if (command) return { ...base, kind: 'command', detail: command[1]!, size: null };

  if (machineOrigin) return null;

  const text = content.trim();
  // A local command's own stdout is echoed back as a user line.
  if (text.startsWith('<local-command-stdout>')) return null;
  if (text.length < steerMinChars) return null;
  return { ...base, kind: 'steer', detail: null, size: text.length };
}

export type CostStateModel = {
  model: string;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  costUSD: number;
};

export type CostState = {
  session: string;
  totalCostUSD: number | null;
  totalApiDurationMs: number | null;
  totalToolDurationMs: number | null;
  totalDurationMs: number | null;
  linesAdded: number | null;
  linesRemoved: number | null;
  unknownModelCost: boolean;
  models: CostStateModel[];
};

/**
 * Claude Code's own billing line, emitted once per session. This is the only
 * place dollars appear in a transcript, and it is what seeds and then
 * reconciles the rate cards.
 */
export function parseCostState(line: string): CostState | null {
  if (!line.includes('"cost-state"')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (entry['type'] !== 'cost-state' || typeof entry['sessionId'] !== 'string') return null;

  const numOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const models: CostStateModel[] = [];
  const usage = (entry['modelUsage'] ?? {}) as Record<string, Record<string, unknown>>;
  for (const [model, u] of Object.entries(usage)) {
    models.push({
      model,
      input: num(u?.['inputTokens']),
      output: num(u?.['outputTokens']),
      thinking: num(u?.['thinkingTokens']),
      cacheRead: num(u?.['cacheReadInputTokens']),
      cacheWrite: num(u?.['cacheCreationInputTokens']),
      costUSD: num(u?.['costUSD']),
    });
  }

  return {
    session: entry['sessionId'],
    totalCostUSD: numOrNull(entry['totalCostUSD']),
    totalApiDurationMs: numOrNull(entry['totalAPIDuration']),
    totalToolDurationMs: numOrNull(entry['totalToolDuration']),
    totalDurationMs: numOrNull(entry['totalDuration']),
    linesAdded: numOrNull(entry['totalLinesAdded']),
    linesRemoved: numOrNull(entry['totalLinesRemoved']),
    unknownModelCost: entry['hasUnknownModelCost'] === true,
    models,
  };
}

export const HEAD_LEN = 4096;

/**
 * SHA-256 of a file's leading bytes -- the fingerprint that detects a rewrite.
 *
 * The length hashed is returned and must be stored, so that a later check can
 * hash exactly the same prefix. Hashing "whatever fits in 4 KiB" instead would
 * make every append to a file under 4 KiB look like a rewrite, and a transcript
 * spends its first minutes below that.
 */
export function headHash(file: string, len = HEAD_LEN): { hash: string; len: number } {
  const handle = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(handle, buf, 0, len, 0);
    return { hash: createHash('sha256').update(buf.subarray(0, read)).digest('hex'), len: read };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Complete lines from a byte offset, with the offset just past each one.
 *
 * A trailing partial line is deliberately never yielded: a transcript being
 * written to can end mid-record, and resuming from a boundary that is not a
 * newline would corrupt the next read. The yielded offset is therefore always
 * a safe resume point.
 */
export function* linesFrom(
  file: string,
  startOffset = 0,
): Generator<{ line: string; nextOffset: number }> {
  const handle = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let pending = Buffer.alloc(0);
    let lineStart = startOffset;
    let readPos = startOffset;
    for (;;) {
      const read = fs.readSync(handle, chunk, 0, chunk.length, readPos);
      if (read === 0) break;
      readPos += read;
      pending = Buffer.concat([pending, chunk.subarray(0, read)]);
      let idx: number;
      while ((idx = pending.indexOf(0x0a)) !== -1) {
        const line = pending.subarray(0, idx).toString('utf8');
        lineStart += idx + 1;
        yield { line, nextOffset: lineStart };
        pending = pending.subarray(idx + 1);
      }
    }
  } finally {
    fs.closeSync(handle);
  }
}
