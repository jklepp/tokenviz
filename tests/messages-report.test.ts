import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import { buildMessages, cellKey, learnNames } from '../src/report/messages.ts';

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

function sandbox(adapter: string | null = 'commander'): { db: DatabaseSync; project: Project } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-msg-'));
  const db = openDb(path.join(dir, 'store.sqlite'));
  opened.push({ dir, db });
  const project = registerProject(db, { rootPath: path.join(dir, 'repo'), adapter });
  return { db, project };
}

let seq = 0;

/** A send, optionally with the delivery result the transcript reported. */
function send(
  db: DatabaseSync,
  project: Project,
  o: { slot: string; to: string; ts: string; body?: string; summary?: string; msgId?: string; delivered?: boolean },
): string {
  const id = `toolu_${++seq}`;
  db.prepare(
    `INSERT INTO agent_send (project_id, tool_use_id, session, slot, ts, to_name, summary, body,
       skill, msg_id, delivered, error, first_seen_at)
     VALUES (?, ?, 'sess', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, '2026-01-01T00:00:00Z')`,
  ).run(
    project.id, id, o.slot, o.ts, o.to, o.summary ?? null, o.body ?? 'body',
    o.msgId ?? null, o.delivered === undefined ? null : o.delivered ? 1 : 0,
  );
  return id;
}

/** The recipient's surviving copy of a message. */
function receive(
  db: DatabaseSync,
  project: Project,
  o: { slot: string; ts: string; msgId: string; fromName?: string },
): void {
  db.prepare(
    `INSERT INTO agent_receive (project_id, uuid, session, slot, ts, msg_id, from_name, from_mode,
       body, git_branch, first_seen_at)
     VALUES (?, ?, 'sess', ?, ?, ?, ?, 'prompting', 'body', NULL, '2026-01-01T00:00:00Z')`,
  ).run(project.id, `uuid_${++seq}`, o.slot, o.ts, o.msgId, o.fromName ?? null);
}

function dispatch(
  db: DatabaseSync,
  project: Project,
  o: { slot: string; ts: string; type: string; agentId?: string; prompt?: string },
): void {
  db.prepare(
    `INSERT INTO agent_dispatch (project_id, tool_use_id, session, slot, ts, subagent_type,
       description, prompt, skill, agent_id, model, status, first_seen_at)
     VALUES (?, ?, 'sess', ?, ?, ?, NULL, ?, NULL, ?, NULL, 'async_launched', '2026-01-01T00:00:00Z')`,
  ).run(project.id, `toolu_d${++seq}`, o.slot, o.ts, o.type, o.prompt ?? 'go', o.agentId ?? null);
}

function addPull(db: DatabaseSync, project: Project, n: number, headRef: string, created: string, merged: string) {
  const slot = /^agent\/([a-z])\//.exec(headRef)?.[1];
  db.prepare(
    `INSERT INTO pull_request (project_id, number, head_ref, base_ref, title, slot, task_slug,
       state, created_at, merged_at, closed_at, first_seen_at)
     VALUES (?, ?, ?, 'integration', ?, ?, ?, 'merged', ?, ?, NULL, '2026-01-01T00:00:00Z')`,
  ).run(project.id, n, headRef, `pr ${n}`, slot ? `agent${slot}` : null, headRef.split('/').pop(), created, merged);
}

describe('resolving a message recipient', () => {
  test('a surviving receive makes the recipient observed fact', () => {
    const { db, project } = sandbox();
    send(db, project, { slot: 'ceo', to: 'agenta-ff', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    receive(db, project, { slot: 'agenta', ts: '2026-02-01T10:00:01Z', msgId: 'm1', fromName: 'ceo-cc' });

    const v = buildMessages(db, project, { from: 'ceo', to: 'agenta' });
    assert.equal(v.messages.length, 1);
    assert.equal(v.messages[0]!.rung, 'confirmed');
    assert.equal(v.messages[0]!.target.key, 'agenta');
    assert.equal(v.messages[0]!.fromName, 'ceo-cc');
  });

  test('a compacted receive is still placed, by a name learned from confirmed ones', () => {
    // This is the case the whole ladder exists for: Claude Code drops inbound
    // peer lines when it compacts, so a fifth of real messages have no
    // surviving recipient copy. Losing them would understate every edge.
    const { db, project } = sandbox();
    send(db, project, { slot: 'ceo', to: 'agenta-ff', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    receive(db, project, { slot: 'agenta', ts: '2026-02-01T10:00:01Z', msgId: 'm1' });
    // Same name, but this one's inbound copy is gone.
    send(db, project, { slot: 'ceo', to: 'agenta-ff', ts: '2026-02-02T10:00:00Z', msgId: 'm2', delivered: true });

    const v = buildMessages(db, project, { from: 'ceo', to: 'agenta' });
    assert.equal(v.messages.length, 2);
    assert.deepEqual(v.messages.map((m) => m.rung).sort(), ['attributed', 'confirmed']);
    assert.equal(v.compacted, 1);
    assert.equal(v.cells.get(cellKey('ceo', 'agenta'))?.count, 2);
  });

  test('a name that resolved to two slots is not resolved at all', () => {
    // A name is a session identity, and nothing guarantees one is never
    // reused. Picking the more frequent slot would put real messages on an
    // edge they were never sent along, so an ambiguous name is dropped.
    const { db, project } = sandbox();
    send(db, project, { slot: 'ceo', to: 'shared', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    receive(db, project, { slot: 'agenta', ts: '2026-02-01T10:00:01Z', msgId: 'm1' });
    send(db, project, { slot: 'ceo', to: 'shared', ts: '2026-02-02T10:00:00Z', msgId: 'm2', delivered: true });
    receive(db, project, { slot: 'agentb', ts: '2026-02-02T10:00:01Z', msgId: 'm2' });
    send(db, project, { slot: 'ceo', to: 'shared', ts: '2026-02-03T10:00:00Z', msgId: 'm3', delivered: true });

    assert.equal(learnNames(db, project).has('shared'), false);
    const v = buildMessages(db, project);
    assert.equal(v.unresolved, 1);
  });

  test('a message addressed to a running subagent lands in that subagent column', () => {
    const { db, project } = sandbox();
    dispatch(db, project, { slot: 'integrate', ts: '2026-02-01T09:00:00Z', type: 'security-reviewer', agentId: 'a99' });
    send(db, project, { slot: 'integrate', to: 'a99', ts: '2026-02-01T09:30:00Z', msgId: 'm1', delivered: true });

    const v = buildMessages(db, project, { from: 'integrate', to: 'agent:security-reviewer' });
    assert.equal(v.selectedTotal, 2, 'the dispatch and the mid-flight correction');
    assert.deepEqual(v.messages.map((m) => m.channel).sort(), ['dispatch', 'peer']);
    assert.ok(v.agentTargets.some((t) => t.key === 'agent:security-reviewer'));
  });

  test('a failed send is counted as never delivered', () => {
    const { db, project } = sandbox();
    send(db, project, { slot: 'agentb', to: 'stale-pipe', ts: '2026-02-01T10:00:00Z', delivered: false });
    const v = buildMessages(db, project);
    assert.equal(v.failures, 1);
    assert.equal(v.total, 1);
  });
});

describe('placing a message on the task spine', () => {
  test('a task window places the message, and beats a number in the text', () => {
    const { db, project } = sandbox();
    addPull(db, project, 500, 'agent/a/the-real-task', '2026-02-01T00:00:00Z', '2026-02-03T00:00:00Z');
    addPull(db, project, 501, 'agent/b/other', '2026-02-01T00:00:00Z', '2026-02-03T00:00:00Z');
    send(db, project, {
      slot: 'ceo',
      to: 'agenta-ff',
      ts: '2026-02-02T10:00:00Z',
      msgId: 'm1',
      delivered: true,
      body: 'while you are there, see PR #501 for context',
    });
    receive(db, project, { slot: 'agenta', ts: '2026-02-02T10:00:01Z', msgId: 'm1' });

    const v = buildMessages(db, project, { from: 'ceo', to: 'agenta' });
    assert.equal(v.messages[0]!.prNumber, 500);
    assert.equal(v.messages[0]!.taskSource, 'window');
  });

  test('with no window, a PR the message names is used, and marked as a mention', () => {
    // The Integrator has almost no Task windows -- its work is promotions --
    // so without this the busiest edge in the fleet has no spine at all.
    const { db, project } = sandbox();
    addPull(db, project, 385, 'agent/a/document-the-bytelru', '2026-02-01T00:00:00Z', '2026-02-03T00:00:00Z');
    send(db, project, {
      slot: 'ceo',
      to: 'integrate-15',
      ts: '2026-03-20T10:00:00Z',
      msgId: 'm1',
      delivered: true,
      summary: 'Integrate PR 385',
    });
    receive(db, project, { slot: 'integrate', ts: '2026-03-20T10:00:01Z', msgId: 'm1' });

    const v = buildMessages(db, project, { from: 'ceo', to: 'integrate' });
    assert.equal(v.messages[0]!.prNumber, 385);
    assert.equal(v.messages[0]!.taskSource, 'mentioned');
  });

  test('a number that is not one of this project’s pull requests invents nothing', () => {
    const { db, project } = sandbox();
    addPull(db, project, 385, 'agent/a/real', '2026-02-01T00:00:00Z', '2026-02-03T00:00:00Z');
    send(db, project, {
      slot: 'ceo',
      to: 'integrate-15',
      ts: '2026-03-20T10:00:00Z',
      msgId: 'm1',
      delivered: true,
      body: 'see item #3 in the checklist, and issue #99999',
    });
    receive(db, project, { slot: 'integrate', ts: '2026-03-20T10:00:01Z', msgId: 'm1' });

    const v = buildMessages(db, project, { from: 'ceo', to: 'integrate' });
    assert.equal(v.messages[0]!.prNumber, null);
    assert.equal(v.messages[0]!.taskSource, null);
  });

  test('a project with no workflow adapter gets messages but no task spine', () => {
    const { db, project } = sandbox(null);
    send(db, project, { slot: 'main', to: 'other', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    receive(db, project, { slot: 'main', ts: '2026-02-01T10:00:01Z', msgId: 'm1' });

    const v = buildMessages(db, project);
    assert.equal(v.total, 1);
    assert.equal(v.messages.length, 0, 'nothing selected');
  });
});

describe('the grid', () => {
  test('counts every message, including those the selection hides', () => {
    // Selecting a cell must never change the totals the reader is looking at.
    const { db, project } = sandbox();
    send(db, project, { slot: 'ceo', to: 'agenta-ff', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    receive(db, project, { slot: 'agenta', ts: '2026-02-01T10:00:01Z', msgId: 'm1' });
    send(db, project, { slot: 'ceo', to: 'agentb-cd', ts: '2026-02-01T11:00:00Z', msgId: 'm2', delivered: true });
    receive(db, project, { slot: 'agentb', ts: '2026-02-01T11:00:01Z', msgId: 'm2' });

    const v = buildMessages(db, project, { from: 'ceo', to: 'agenta' });
    assert.equal(v.total, 2);
    assert.equal(v.selectedTotal, 1);
    assert.equal(v.senders.find((s) => s.slot === 'ceo')?.sent, 2);
  });

  test('the grid carries no message bodies; only a selection fetches them', () => {
    // Loading every body to draw the grid cost nine seconds a page on the
    // Commander corpus, for 4MB of text nobody had asked to read yet. The
    // counts must stay derivable without it.
    const { db, project } = sandbox();
    send(db, project, {
      slot: 'ceo',
      to: 'agenta-ff',
      ts: '2026-02-01T10:00:00Z',
      msgId: 'm1',
      delivered: true,
      body: 'the whole brief',
    });
    receive(db, project, { slot: 'agenta', ts: '2026-02-01T10:00:01Z', msgId: 'm1' });

    const grid = buildMessages(db, project);
    assert.equal(grid.total, 1, 'counted');
    assert.equal(grid.messages.length, 0, 'but nothing materialised');

    const selected = buildMessages(db, project, { from: 'ceo', to: 'agenta' });
    assert.equal(selected.messages[0]!.body, 'the whole brief');
  });

  test('a selected dispatch gets its prompt, not an empty body', () => {
    const { db, project } = sandbox();
    dispatch(db, project, {
      slot: 'agenta',
      ts: '2026-02-01T10:00:00Z',
      type: 'spec-reviewer',
      prompt: 'check the spec',
    });
    const v = buildMessages(db, project, { from: 'agenta', to: 'agent:spec-reviewer' });
    assert.equal(v.messages[0]!.body, 'check the spec');
  });

  test('the unresolved column is not a slot among the slots', () => {
    const { db, project } = sandbox();
    send(db, project, { slot: 'ceo', to: 'nobody', ts: '2026-02-01T10:00:00Z', msgId: 'm1', delivered: true });
    const v = buildMessages(db, project);
    const keys = v.peerTargets.map((t) => t.key);
    assert.equal(keys.filter((k) => k === 'unknown').length, 1);
    assert.equal(v.peerTargets.find((t) => t.key === 'unknown')?.kind, 'unknown');
  });
});
