import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import { parseEvent } from '../src/sources/transcripts.ts';
import {
  classifyBranch,
  effectiveWindowStart,
  reconstructTasks,
  roleOf,
  SILENCE_TIMEOUT_MS,
} from '../src/adapters/commander/tasks.ts';

const opened: { dir: string; db: DatabaseSync }[] = [];

after(() => {
  for (const { dir, db } of opened) {
    try {
      db.close();
    } catch {
      // already closed
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a handle; a leftover temp dir is not a failure.
    }
  }
});

function sandbox(): { db: DatabaseSync; project: Project } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-tasks-'));
  const db = openDb(path.join(dir, 'store.sqlite'));
  opened.push({ dir, db });
  const project = registerProject(db, { rootPath: path.join(dir, 'repo') });
  return { db, project };
}

function addPull(
  db: DatabaseSync,
  project: Project,
  n: number,
  headRef: string,
  createdAt: string,
  mergedAt: string | null,
  closedAt: string | null = null,
) {
  db.prepare(
    `INSERT INTO pull_request (project_id, number, head_ref, base_ref, title, slot, task_slug,
       state, created_at, merged_at, closed_at, first_seen_at)
     VALUES (?, ?, ?, 'integration', ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`,
  ).run(
    project.id, n, headRef, `pr ${n}`,
    classifyBranch(headRef)?.slot ?? null,
    classifyBranch(headRef)?.taskSlug ?? null,
    mergedAt ? 'MERGED' : closedAt ? 'CLOSED' : 'OPEN',
    createdAt, mergedAt, closedAt,
  );
}

function addRequest(db: DatabaseSync, project: Project, slot: string, ts: string, id: string) {
  db.prepare(
    `INSERT INTO request (project_id, message_id, session, slot, origin, model, ts, day,
       input, cache_write, cache_write_5m, cache_write_1h, cache_read, output, thinking,
       iterations, service_tier, cwd, first_seen_at)
     VALUES (?, ?, 's', ?, 'console', 'claude-sonnet-5', ?, ?, 1, 0, 0, 0, 100, 5, 0, 0, NULL, NULL, ?)`,
  ).run(project.id, id, slot, ts, ts.slice(0, 10), ts);
}

describe('classifyBranch', () => {
  test('reads slot and task from a coder branch, expanding the slot letter', () => {
    assert.deepEqual(classifyBranch('agent/b/shorten-the-welcome'), {
      slot: 'agentb',
      taskSlug: 'shorten-the-welcome',
    });
  });

  test('reads an integrator branch', () => {
    assert.deepEqual(classifyBranch('integrate/trivy-workflow-parity'), {
      slot: 'integrate',
      taskSlug: 'trivy-workflow-parity',
    });
  });

  test('declines branches that name no slot rather than guessing', () => {
    assert.equal(classifyBranch('feature/codera'), null);
    assert.equal(classifyBranch('main'), null);
    assert.equal(classifyBranch('agent/toolong/x'), null);
  });
});

describe('roleOf', () => {
  test('derives the role from the slot name', () => {
    assert.equal(roleOf('agenta'), 'Coder');
    assert.equal(roleOf('agentd'), 'Coder');
    assert.equal(roleOf('integrate'), 'Integrator');
    assert.equal(roleOf('ceo'), 'CEO');
    assert.equal(roleOf('main'), 'Owner');
  });
});

describe('reconstructTasks', () => {
  test('each task owns its slot from the previous task in that slot', () => {
    const { db, project } = sandbox();
    addPull(db, project, 1, 'agent/a/one', '2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z');
    addPull(db, project, 2, 'agent/a/two', '2026-09-01T03:00:00Z', '2026-09-01T05:00:00Z');
    addPull(db, project, 3, 'agent/b/other', '2026-09-01T01:00:00Z', '2026-09-01T04:00:00Z');

    const tasks = reconstructTasks(db, project);
    const a = tasks.filter((t) => t.slot === 'agenta');
    assert.equal(a.length, 2);
    assert.equal(a[0]!.windowStart, null, 'the first task in a slot has no lower bound');
    assert.equal(a[0]!.windowEnd, '2026-09-01T02:00:00Z');
    assert.equal(a[1]!.windowStart, '2026-09-01T02:00:00Z', 'the second starts where the first closed');

    // Another slot's timings must not shift this one's boundaries.
    const b = tasks.filter((t) => t.slot === 'agentb');
    assert.equal(b[0]!.windowStart, null);
  });

  test('an unmerged, closed PR is abandoned rather than landed', () => {
    const { db, project } = sandbox();
    addPull(db, project, 1, 'agent/a/dropped', '2026-09-01T00:00:00Z', null, '2026-09-01T01:00:00Z');
    const [task] = reconstructTasks(db, project);
    assert.equal(task!.outcome, 'abandoned');
  });
});

describe('effectiveWindowStart', () => {
  test('a long silence cuts a task off from earlier work', () => {
    const { db, project } = sandbox();
    addPull(db, project, 1, 'agent/a/one', '2026-09-02T00:00:00Z', '2026-09-02T12:00:00Z');
    // Two days of unrelated work, then a gap, then the task itself.
    addRequest(db, project, 'agenta', '2026-08-30T09:00:00Z', 'old-1');
    addRequest(db, project, 'agenta', '2026-08-30T09:05:00Z', 'old-2');
    addRequest(db, project, 'agenta', '2026-09-02T10:00:00Z', 'new-1');
    addRequest(db, project, 'agenta', '2026-09-02T10:30:00Z', 'new-2');

    const [task] = reconstructTasks(db, project);
    assert.equal(task!.windowStart, null, 'the raw window is unbounded');

    const start = effectiveWindowStart(db, project, task!);
    assert.equal(start, '2026-08-30T09:05:00Z', 'work begins after the last pre-gap request');
  });

  test('contiguous work is kept whole', () => {
    const { db, project } = sandbox();
    addPull(db, project, 1, 'agent/a/one', '2026-09-02T00:00:00Z', '2026-09-02T12:00:00Z');
    for (let i = 0; i < 5; i++) {
      addRequest(db, project, 'agenta', `2026-09-02T0${i + 1}:00:00Z`, `r${i}`);
    }
    const [task] = reconstructTasks(db, project);
    assert.equal(effectiveWindowStart(db, project, task!), null, 'no gap means nothing is cut off');
  });

  test('the timeout is a parameter, and a shorter one cuts more', () => {
    const { db, project } = sandbox();
    addPull(db, project, 1, 'agent/a/one', '2026-09-02T00:00:00Z', '2026-09-02T12:00:00Z');
    addRequest(db, project, 'agenta', '2026-09-02T01:00:00Z', 'a');
    addRequest(db, project, 'agenta', '2026-09-02T04:00:00Z', 'b'); // a 3h gap

    const [task] = reconstructTasks(db, project);
    assert.equal(effectiveWindowStart(db, project, task!, SILENCE_TIMEOUT_MS), null, '3h < 6h, kept');
    assert.equal(
      effectiveWindowStart(db, project, task!, 60 * 60 * 1000),
      '2026-09-02T01:00:00Z',
      '3h > 1h, cut',
    );
  });
});

describe('parseEvent', () => {
  const line = (o: Record<string, unknown>) =>
    JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-09-01T00:00:00Z', ...o });

  test('a slash command is recorded with its name', () => {
    const e = parseEvent(line({ message: { content: '<command-name>/start</command-name>' } }));
    assert.equal(e?.kind, 'command');
    assert.equal(e?.detail, '/start');
  });

  test('a denied tool call and an interrupt are takeover signals', () => {
    assert.equal(parseEvent(line({ toolDenialKind: 'reject', message: { content: 'x' } }))?.kind, 'denial');
    assert.equal(parseEvent(line({ interruptedMessageId: 'm1', message: { content: 'x' } }))?.kind, 'interrupt');
  });

  test('a substantive typed message is a steer', () => {
    const e = parseEvent(line({ message: { content: 'x'.repeat(150) } }));
    assert.equal(e?.kind, 'steer');
    assert.equal(e?.size, 150);
  });

  test('assent is not a steer', () => {
    assert.equal(parseEvent(line({ message: { content: 'yes, go on' } })), null);
  });

  test('machine-generated user lines are not a human typing', () => {
    const long = 'x'.repeat(400);
    // These three put a takeover on 95% of tasks before they were excluded.
    assert.equal(parseEvent(line({ isMeta: true, message: { content: long } })), null);
    assert.equal(parseEvent(line({ sourceToolUseID: 't1', message: { content: long } })), null);
    assert.equal(
      parseEvent(line({ message: { content: `<local-command-stdout>${long}</local-command-stdout>` } })),
      null,
    );
  });

  test('a command is still recognised on a meta line', () => {
    // Re-invocations are marked isMeta but the command itself still happened.
    const e = parseEvent(line({ isMeta: true, message: { content: '<command-name>/pr</command-name>' } }));
    assert.equal(e?.kind, 'command');
  });

  test('tool results, which arrive as arrays, are not events', () => {
    assert.equal(parseEvent(line({ message: { content: [{ type: 'tool_result', content: 'ok' }] } })), null);
  });
});
