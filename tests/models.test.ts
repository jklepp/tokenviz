import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import {
  baseModel,
  cacheWriteMix,
  cardModelFor,
  requestModelsFor,
} from '../src/pricing/models.ts';

/**
 * Model-to-card resolution is the one thing here that fails silently: a join
 * that matches nothing prices a whole token category at zero and returns a
 * total that is low but entirely plausible. These tests exist because that
 * happened twice before it was caught.
 */

const opened: { dir: string; db: DatabaseSync }[] = [];
after(() => {
  for (const { dir, db } of opened) {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle */ }
  }
});

function sandbox(): { db: DatabaseSync; project: Project } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-models-'));
  const db = openDb(path.join(dir, 'store.sqlite'));
  opened.push({ dir, db });
  return { db, project: registerProject(db, { rootPath: path.join(dir, 'repo') }) };
}

function addWrite(db: DatabaseSync, project: Project, model: string, m5: number, m1h: number) {
  db.prepare(
    `INSERT INTO request (project_id, message_id, session, slot, origin, model, ts, day,
       input, cache_write, cache_write_5m, cache_write_1h, cache_read, output, thinking,
       iterations, service_tier, cwd, first_seen_at)
     VALUES (?, ?, 's', 'main', 'console', ?, '2026-09-01T00:00:00Z', '2026-09-01',
       0, ?, ?, ?, 0, 0, 0, 0, NULL, NULL, '2026-09-01T00:00:00Z')`,
  ).run(project.id, `${model}-${m5}-${m1h}-${Math.random()}`, model, m5 + m1h, m5, m1h);
}

const alias = (db: DatabaseSync, from: string, to: string) =>
  db
    .prepare(
      `INSERT INTO model_alias (request_model, card_model, reason, created_at)
       VALUES (?, ?, 'test', '2026-09-01T00:00:00Z')`,
    )
    .run(from, to);

describe('baseModel', () => {
  test('strips a context-tier suffix', () => {
    assert.equal(baseModel('claude-opus-5[1m]'), 'claude-opus-5');
  });

  test('leaves an ordinary name alone', () => {
    assert.equal(baseModel('claude-sonnet-5'), 'claude-sonnet-5');
    assert.equal(baseModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
  });
});

describe('cardModelFor', () => {
  test('follows an alias', () => {
    const { db } = sandbox();
    alias(db, 'claude-opus-5', 'claude-opus-5[1m]');
    assert.equal(cardModelFor(db, 'claude-opus-5'), 'claude-opus-5[1m]');
  });

  test('falls back to the model itself', () => {
    const { db } = sandbox();
    assert.equal(cardModelFor(db, 'claude-sonnet-5'), 'claude-sonnet-5');
  });
});

describe('requestModelsFor', () => {
  test('includes the tier-stripped name before any alias exists', () => {
    const { db } = sandbox();
    // This is the first-run case: cards are written before aliases are seeded,
    // so the solver must still find the traffic belonging to a tiered card.
    assert.deepEqual(
      requestModelsFor(db, 'claude-opus-5[1m]').sort(),
      ['claude-opus-5', 'claude-opus-5[1m]'],
    );
  });

  test('includes anything aliased to the card', () => {
    const { db } = sandbox();
    alias(db, 'claude-opus-5', 'claude-opus-5[1m]');
    assert.ok(requestModelsFor(db, 'claude-opus-5[1m]').includes('claude-opus-5'));
  });

  test('does not invent names for an untiered model', () => {
    const { db } = sandbox();
    assert.deepEqual(requestModelsFor(db, 'claude-sonnet-5'), ['claude-sonnet-5']);
  });
});

describe('cacheWriteMix', () => {
  test('a tiered card finds traffic recorded under the bare alias', () => {
    const { db, project } = sandbox();
    // Transcripts record the bare name; the card is tiered. Looking up the mix
    // under the card name alone matched nothing and silently fell back to 2x.
    addWrite(db, project, 'claude-opus-5', 200, 800);

    const mix = cacheWriteMix(db, project.id, 'claude-opus-5[1m]');
    assert.ok(Math.abs(mix.m5 - 0.2) < 1e-9, `m5 ${mix.m5}`);
    assert.ok(Math.abs(mix.blend - (0.2 * 1.25 + 0.8 * 2.0)) < 1e-9, `blend ${mix.blend}`);
    assert.notEqual(mix.blend, 2.0, 'a flat 2x is the symptom of the resolution failing');
  });

  test('another model’s writes do not leak into the mix', () => {
    const { db, project } = sandbox();
    addWrite(db, project, 'claude-opus-5', 0, 1000);
    addWrite(db, project, 'claude-sonnet-5', 1000, 0);

    assert.equal(cacheWriteMix(db, project.id, 'claude-opus-5[1m]').blend, 2.0);
    assert.equal(cacheWriteMix(db, project.id, 'claude-sonnet-5').blend, 1.25);
  });

  test('with no traffic it assumes the dearer tier', () => {
    const { db, project } = sandbox();
    const mix = cacheWriteMix(db, project.id, 'never-seen');
    assert.equal(mix.blend, 2.0, 'an unknown must not flatter a derived rate');
  });

  test('omitting the model gives the whole project', () => {
    const { db, project } = sandbox();
    addWrite(db, project, 'a', 500, 500);
    addWrite(db, project, 'b', 500, 500);
    assert.ok(Math.abs(cacheWriteMix(db, project.id).m5 - 0.5) < 1e-9);
  });
});
