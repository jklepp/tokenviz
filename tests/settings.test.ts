import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import { costSummary } from '../src/pricing/cost.ts';
import { saveRates } from '../src/server/serve.ts';

const opened: { dir: string; db: DatabaseSync }[] = [];

after(() => {
  for (const { dir, db } of opened) {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle */ }
  }
});

const MODEL = 'test-model';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-set-'));
  const db = openDb(path.join(dir, 'store.sqlite'));
  opened.push({ dir, db });
  const project = registerProject(db, { rootPath: path.join(dir, 'repo') });

  db.prepare(
    `INSERT INTO rate_card (model, valid_from, input_per_mtok, output_per_mtok,
       cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok, source, created_at)
     VALUES (?, '2026-08-01T00:00:00Z', 2, 10, 2.5, 4, 0.2, 'test', '2026-08-01T00:00:00Z')`,
  ).run(MODEL);

  // One million output tokens on each of two days, so a rate change is easy to
  // reason about: +$1 per dollar of output rate, per day.
  for (const [i, ts] of ['2026-09-01T12:00:00Z', '2026-09-05T12:00:00Z'].entries()) {
    db.prepare(
      `INSERT INTO request (project_id, message_id, session, slot, origin, model, ts, day,
         input, cache_write, cache_write_5m, cache_write_1h, cache_read, output, thinking,
         iterations, service_tier, cwd, first_seen_at)
       VALUES (?, ?, 's', 'main', 'console', ?, ?, ?, 0, 0, 0, 0, 0, 1000000, 0, 0, NULL, NULL, ?)`,
    ).run(project.id, `m${i}`, MODEL, ts, ts.slice(0, 10), ts);
  }
  return { db, project };
}

const form = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    [`input:${MODEL}`]: '2',
    [`output:${MODEL}`]: '10',
    [`cw5m:${MODEL}`]: '2.5',
    [`cw1h:${MODEL}`]: '4',
    [`read:${MODEL}`]: '0.2',
    valid_from: '',
    ...over,
  });

describe('saving rates', () => {
  test('the two requests cost what the card says to begin with', () => {
    const { db, project } = sandbox();
    assert.equal(costSummary(db, project).totalUSD, 20);
  });

  test('saving an unedited form changes nothing', () => {
    const { db, project } = sandbox();
    const res = saveRates(db, project, form());
    assert.match(res.text, /unchanged/);
    assert.equal(costSummary(db, project).totalUSD, 20);
  });

  test('editing in place re-costs all of history', () => {
    const { db, project } = sandbox();
    saveRates(db, project, form({ [`output:${MODEL}`]: '20' }));
    assert.equal(costSummary(db, project).totalUSD, 40, 'both days re-costed');
  });

  test('a backdated card re-costs only from its date', () => {
    const { db, project } = sandbox();
    const res = saveRates(
      db,
      project,
      form({ [`output:${MODEL}`]: '20', valid_from: '2026-09-03' }),
    );
    // Sep 1 keeps the old rate, Sep 5 takes the new one: 10 + 20.
    assert.equal(costSummary(db, project).totalUSD, 30, 'only the later request moved');
    assert.match(res.text, /effective 2026-09-03/);
    assert.match(res.text, /\$10\.00/, 'the movement is reported, not silent');
  });

  test('a correction can be applied twice without compounding', () => {
    const { db, project } = sandbox();
    const f = () => form({ [`output:${MODEL}`]: '20', valid_from: '2026-09-03' });
    saveRates(db, project, f());
    saveRates(db, project, f());
    assert.equal(costSummary(db, project).totalUSD, 30, 'the card is replaced, not stacked');
  });

  test('a negative or unparseable rate is refused rather than written', () => {
    const { db, project } = sandbox();
    saveRates(db, project, form({ [`output:${MODEL}`]: '-5' }));
    assert.equal(costSummary(db, project).totalUSD, 20, 'the card is untouched');
    saveRates(db, project, form({ [`output:${MODEL}`]: 'free' }));
    assert.equal(costSummary(db, project).totalUSD, 20);
  });

  test('a context window is stored against the model', () => {
    const { db, project } = sandbox();
    saveRates(db, project, form({ [`ctx:${MODEL}`]: '200000' }));
    const row = db.prepare('SELECT context_window FROM model_setting WHERE model = ?').get(MODEL) as
      | { context_window: number }
      | undefined;
    assert.equal(row?.context_window, 200000);
  });
});
