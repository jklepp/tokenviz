import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import { ingestTranscripts } from '../src/ingest/transcripts.ts';
import { isProjectDir, parseUsage, projectSlug, slotOf } from '../src/sources/transcripts.ts';

/**
 * Fixtures here are synthetic. Real transcripts never enter this repo -- it is
 * public and the corpus spans private projects. See docs/adr/ and .gitignore.
 *
 * Every test gets its own projects root and its own database, because ingest
 * scans a whole directory tree: a file left behind by one test would silently
 * become another test's input.
 */

const sandboxes: { dir: string; db: DatabaseSync }[] = [];

after(() => {
  for (const { dir, db } of sandboxes) {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a handle briefly; a leftover temp dir is not a failure.
    }
  }
});

type Sandbox = {
  db: DatabaseSync;
  project: Project;
  slotDir: (slot?: string) => string;
};

function sandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-test-'));
  const projectsRoot = path.join(dir, 'projects');
  const projectRoot = path.join(dir, 'repo');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  process.env['TOKENVIZ_PROJECTS_ROOT'] = projectsRoot;

  const db = openDb(path.join(dir, 'store.sqlite'));
  sandboxes.push({ dir, db });
  const project = registerProject(db, { rootPath: projectRoot });

  return {
    db,
    project,
    slotDir(slot?: string) {
      const slug = projectSlug(projectRoot) + (slot ? `--claude-worktrees-${slot}` : '');
      const d = path.join(projectsRoot, slug);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

function usageLine(opts: { id: string | null; ts: string; model?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    cwd: 'C:\\somewhere\\repo',
    message: {
      id: opts.id,
      model: opts.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: 1,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 100,
        output_tokens: 5,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 },
        output_tokens_details: { thinking_tokens: 2 },
      },
    },
  });
}

const noise = () => JSON.stringify({ type: 'attachment', content: 'nothing billable here' });
const lines = (...l: string[]) => l.join('\n') + '\n';

describe('project directory matching', () => {
  test('a sibling checkout is not billed to this project', () => {
    const root = projectSlug('C:\\AI\\Commander');
    assert.equal(isProjectDir(root, root), true);
    assert.equal(isProjectDir(`${root}--claude-worktrees-agenta`, root), true);
    // The prefix trap: different repositories whose slugs extend this one.
    assert.equal(isProjectDir(projectSlug('C:\\AI\\CommanderTwo'), root), false);
    assert.equal(isProjectDir(projectSlug('C:\\AI\\Commander-Two'), root), false);
  });

  test('the main checkout is the main slot', () => {
    const root = projectSlug('C:\\AI\\Commander');
    assert.equal(slotOf(root, root), 'main');
    assert.equal(slotOf(`${root}--claude-worktrees-AgentA`, root), 'agenta');
  });
});

describe('parseUsage', () => {
  test('a record with no id yields null rather than a guessed key', () => {
    const parsed = parseUsage(usageLine({ id: null, ts: '2026-09-01T00:00:00.000Z' }));
    assert.equal(parsed?.messageId, null);
  });

  test('lines carrying no usage are skipped', () => {
    assert.equal(parseUsage(noise()), null);
  });

  test('the ephemeral cache tiers are kept apart', () => {
    const parsed = parseUsage(usageLine({ id: 'x', ts: '2026-09-01T00:00:00.000Z' }));
    assert.equal(parsed?.cacheWrite1h, 10);
    assert.equal(parsed?.cacheWrite5m, 0);
  });
});

describe('incremental scan', () => {
  test('resumes from the stored offset and picks up appended records', () => {
    const s = sandbox();
    const file = path.join(s.slotDir(), 'session.jsonl');
    fs.writeFileSync(file, lines(usageLine({ id: 'm1', ts: '2026-09-01T00:00:00.000Z' }), noise()));

    const first = ingestTranscripts(s.db, s.project);
    assert.equal(first.requestsInserted, 1);
    assert.equal(first.linesRead, 2);

    fs.appendFileSync(file, usageLine({ id: 'm2', ts: '2026-09-01T00:01:00.000Z' }) + '\n');
    const second = ingestTranscripts(s.db, s.project);

    assert.equal(second.filesResumed, 1, 'should resume, not rescan');
    assert.equal(second.filesRescanned, 0);
    assert.equal(second.requestsInserted, 1, 'only the appended record is new');
    assert.equal(second.linesRead, 1, 'the already-read lines are not re-read');
  });

  test('a rewritten file is re-read from zero, not resumed into', () => {
    const s = sandbox();
    const file = path.join(s.slotDir(), 'session.jsonl');
    fs.writeFileSync(file, lines(usageLine({ id: 'r1', ts: '2026-09-02T00:00:00.000Z' })));
    ingestTranscripts(s.db, s.project);

    // Compaction: rewritten with different leading content, and it grows.
    // Resuming from the old offset would skip real records.
    fs.writeFileSync(
      file,
      lines(
        usageLine({ id: 'r2', ts: '2026-09-02T00:01:00.000Z' }),
        usageLine({ id: 'r3', ts: '2026-09-02T00:02:00.000Z' }),
        usageLine({ id: 'r4', ts: '2026-09-02T00:03:00.000Z' }),
      ),
    );

    const second = ingestTranscripts(s.db, s.project);
    assert.equal(second.filesRescanned, 1, 'a changed head must force a rescan');
    assert.equal(second.filesResumed, 0);
    assert.equal(second.requestsInserted, 3, 'every record in the rewritten file is seen');
  });

  test('a truncated file is re-read even when its head is unchanged', () => {
    const s = sandbox();
    const file = path.join(s.slotDir(), 'session.jsonl');
    const first = usageLine({ id: 's1', ts: '2026-09-03T00:00:00.000Z' });
    fs.writeFileSync(
      file,
      lines(first, usageLine({ id: 's2', ts: '2026-09-03T00:01:00.000Z' }), usageLine({ id: 's3', ts: '2026-09-03T00:02:00.000Z' })),
    );
    ingestTranscripts(s.db, s.project);

    // Only the size check catches this one: the head hash still matches.
    fs.writeFileSync(file, lines(first));
    const second = ingestTranscripts(s.db, s.project);
    assert.equal(second.filesRescanned, 1);
  });

  test('an unchanged file is not reopened', () => {
    const s = sandbox();
    const file = path.join(s.slotDir(), 'session.jsonl');
    fs.writeFileSync(file, lines(usageLine({ id: 'u1', ts: '2026-09-04T00:00:00.000Z' })));
    ingestTranscripts(s.db, s.project);

    const second = ingestTranscripts(s.db, s.project);
    assert.equal(second.filesUnchanged, 1);
    assert.equal(second.linesRead, 0);
  });

  test('a partial trailing line is not consumed until it is complete', () => {
    const s = sandbox();
    const file = path.join(s.slotDir(), 'session.jsonl');
    const complete = usageLine({ id: 'p1', ts: '2026-09-04T00:00:00.000Z' });
    const half = usageLine({ id: 'p2', ts: '2026-09-04T00:01:00.000Z' }).slice(0, 40);
    fs.writeFileSync(file, complete + '\n' + half);

    const first = ingestTranscripts(s.db, s.project);
    assert.equal(first.requestsInserted, 1, 'the half-written record is not counted yet');

    // The writer finishes the record.
    fs.writeFileSync(file, lines(complete, usageLine({ id: 'p2', ts: '2026-09-04T00:01:00.000Z' })));
    const second = ingestTranscripts(s.db, s.project);
    assert.equal(second.requestsInserted, 1, 'and is counted exactly once when complete');
  });
});

describe('deduplication', () => {
  test('a forked session re-emitting records does not double count', () => {
    const s = sandbox();
    const dir = s.slotDir();
    const shared = [
      usageLine({ id: 'f1', ts: '2026-09-05T00:00:00.000Z' }),
      usageLine({ id: 'f2', ts: '2026-09-05T00:01:00.000Z' }),
    ];
    fs.writeFileSync(path.join(dir, 'parent.jsonl'), lines(...shared));
    // The fork carries the parent's records forward, then adds its own.
    fs.writeFileSync(
      path.join(dir, 'child.jsonl'),
      lines(...shared, usageLine({ id: 'f3', ts: '2026-09-05T00:02:00.000Z' })),
    );

    const stats = ingestTranscripts(s.db, s.project);
    assert.equal(stats.requestsInserted, 3, 'the two shared records collapse to one each');

    const row = s.db
      .prepare('SELECT COUNT(*) n FROM request WHERE project_id = ?')
      .get(s.project.id) as { n: number };
    assert.equal(row.n, 3);
  });

  test('id-less records in different sessions stay distinct', () => {
    const s = sandbox();
    const dir = s.slotDir();
    const ts = '2026-09-05T12:00:00.000Z';
    // Same instant, no id, different sessions: two requests, not one.
    fs.writeFileSync(path.join(dir, 'one.jsonl'), lines(usageLine({ id: null, ts })));
    fs.writeFileSync(path.join(dir, 'two.jsonl'), lines(usageLine({ id: null, ts })));

    const stats = ingestTranscripts(s.db, s.project);
    assert.equal(stats.requestsInserted, 2);
  });
});

describe('subagent transcripts', () => {
  test('nested transcripts are found, and billed to the parent slot', () => {
    const s = sandbox();
    const dir = s.slotDir('agenta');
    const nested = path.join(dir, 'sess-1', 'subagents');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), lines(usageLine({ id: 'p1', ts: '2026-09-06T00:00:00.000Z' })));
    fs.writeFileSync(path.join(nested, 'rev.jsonl'), lines(usageLine({ id: 'c1', ts: '2026-09-06T00:01:00.000Z' })));

    const stats = ingestTranscripts(s.db, s.project);
    assert.equal(stats.requestsInserted, 2, 'reading only the top level undercounts');

    const rows = s.db
      .prepare('SELECT origin, slot FROM request WHERE project_id = ? ORDER BY origin')
      .all(s.project.id) as unknown as { origin: string; slot: string }[];
    assert.deepEqual(
      rows.map((r) => [r.origin, r.slot]),
      [
        ['console', 'agenta'],
        ['subagent', 'agenta'],
      ],
      'a subagent bills its parent slot, never one of its own',
    );
  });

  test('two subagents sharing a filename under different sessions stay distinct', () => {
    const s = sandbox();
    const dir = s.slotDir('agentb');
    for (const parent of ['sess-a', 'sess-b']) {
      const nested = path.join(dir, parent, 'subagents');
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        path.join(nested, 'reviewer.jsonl'),
        lines(usageLine({ id: `${parent}-1`, ts: '2026-09-06T01:00:00.000Z' })),
      );
    }

    ingestTranscripts(s.db, s.project);
    const row = s.db
      .prepare('SELECT COUNT(DISTINCT session) n FROM request WHERE project_id = ?')
      .get(s.project.id) as { n: number };
    assert.equal(row.n, 2, 'a bare filename collides; a relative path cannot');
  });
});
