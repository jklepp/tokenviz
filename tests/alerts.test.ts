import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { after, describe, test } from 'node:test';

import { openDb } from '../src/store/db.ts';
import { registerProject, type Project } from '../src/store/projects.ts';
import { checkAlerts, DEFAULT_ALERT_OPTIONS, type AlertOptions } from '../src/report/alerts.ts';

const opened: { dir: string; db: DatabaseSync }[] = [];

after(() => {
  for (const { dir, db } of opened) {
    try { db.close(); } catch { /* already closed */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows handle */ }
  }
});

const MODEL = 'test-model';
const HOUR = 3600000;
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenviz-alert-'));
  const db = openDb(path.join(dir, 'store.sqlite'));
  opened.push({ dir, db });
  const project = registerProject(db, { rootPath: path.join(dir, 'repo') });
  db.prepare(
    `INSERT INTO rate_card (model, valid_from, input_per_mtok, output_per_mtok,
       cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok, source, created_at)
     VALUES (?, '2000-01-01T00:00:00Z', 0, 1, 0, 0, 0, 'test', '2000-01-01T00:00:00Z')`,
  ).run(MODEL);
  return { db, project };
}

/** One request whose cost is exactly `usd`, given the 1 $/MTok output card. */
function req(
  db: DatabaseSync,
  project: Project,
  opts: { session: string; slot?: string; hoursAgo: number; usd: number; origin?: string; cacheRead?: number; input?: number },
) {
  const ts = ago(opts.hoursAgo);
  db.prepare(
    `INSERT INTO request (project_id, message_id, session, slot, origin, model, ts, day,
       input, cache_write, cache_write_5m, cache_write_1h, cache_read, output, thinking,
       iterations, service_tier, cwd, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 0, 0, NULL, NULL, ?)`,
  ).run(
    project.id, `${opts.session}-${Math.random()}`, opts.session, opts.slot ?? 'agenta',
    opts.origin ?? 'console', MODEL, ts, ts.slice(0, 10),
    opts.input ?? 0, opts.cacheRead ?? 0, Math.round(opts.usd * 1_000_000), ts,
  );
}

/** A baseline of `n` sessions in the past, each costing `usd`. */
function baseline(db: DatabaseSync, project: Project, n: number, usd: number, slot = 'agenta') {
  for (let i = 0; i < n; i++) {
    req(db, project, { session: `${slot}-base-${i}`, slot, hoursAgo: 48 + i, usd });
  }
}

const opts = (over: Partial<AlertOptions> = {}): AlertOptions => ({ ...DEFAULT_ALERT_OPTIONS, ...over });
const runaways = (db: DatabaseSync, p: Project, o = opts()) =>
  checkAlerts(db, p, o).filter((a) => a.kind === 'runaway');

describe('runaway sessions', () => {
  test('a session well past the median is flagged', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    req(db, project, { session: 'hot', hoursAgo: 1, usd: 20 });
    const hits = runaways(db, project);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message, /5\.0x/);
  });

  test('a session within the threshold is not', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    req(db, project, { session: 'normal', hoursAgo: 1, usd: 6 });
    assert.equal(runaways(db, project).length, 0);
  });

  test('the baseline excludes the window it is judging', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    // Several expensive recent sessions must not raise the bar for each other.
    for (let i = 0; i < 5; i++) req(db, project, { session: `hot${i}`, hoursAgo: 1, usd: 20 });
    assert.equal(runaways(db, project).length, 5, 'all five are still measured against the old median');
  });

  test('subagent sessions do not drag the baseline down', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    // Dozens of cheap subagent transcripts would pull a naive median to ~0
    // and make every ordinary console session look like a runaway.
    for (let i = 0; i < 40; i++) {
      req(db, project, { session: `sub-${i}`, hoursAgo: 48 + i, usd: 0.05, origin: 'subagent' });
    }
    req(db, project, { session: 'normal', hoursAgo: 1, usd: 6 });
    assert.equal(runaways(db, project).length, 0);
  });

  test('a slot with too little history judges nothing', () => {
    const { db, project } = sandbox();
    baseline(db, project, 3, 4);
    req(db, project, { session: 'hot', hoursAgo: 1, usd: 100 });
    assert.equal(runaways(db, project).length, 0, 'three sessions is not a baseline');
  });

  test('a cheap session is never a warning, whatever the ratio', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 0.1);
    req(db, project, { session: 'tiny', hoursAgo: 1, usd: 1 });
    assert.equal(runaways(db, project).length, 0, '10x of nothing is still nothing');
  });

  test('slots are judged separately', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 1, 'agenta');
    baseline(db, project, 10, 40, 'ceo');
    // Expensive for a coder, ordinary for the CEO.
    req(db, project, { session: 'coder', slot: 'agenta', hoursAgo: 1, usd: 30 });
    req(db, project, { session: 'ceo-run', slot: 'ceo', hoursAgo: 1, usd: 45 });
    const hits = runaways(db, project);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message, /^agenta/);
  });
});

describe('other checks', () => {
  test('a fall in cache hit rate is flagged', () => {
    const { db, project } = sandbox();
    for (let i = 0; i < 10; i++) {
      req(db, project, { session: `b${i}`, hoursAgo: 48 + i, usd: 1, cacheRead: 990, input: 10 });
    }
    req(db, project, { session: 'now', hoursAgo: 1, usd: 1, cacheRead: 500, input: 500 });
    const hits = checkAlerts(db, project).filter((a) => a.kind === 'cache-drop');
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message, /fell to 50\.0%/);
  });

  test('a model with no card is flagged rather than silently dropped', () => {
    const { db, project } = sandbox();
    const ts = ago(1);
    db.prepare(
      `INSERT INTO request (project_id, message_id, session, slot, origin, model, ts, day,
         input, cache_write, cache_write_5m, cache_write_1h, cache_read, output, thinking,
         iterations, service_tier, cwd, first_seen_at)
       VALUES (?, 'x', 's', 'agenta', 'console', 'brand-new-model', ?, ?, 1, 0, 0, 0, 0, 1, 0, 0, NULL, NULL, ?)`,
    ).run(project.id, ts, ts.slice(0, 10), ts);
    const hits = checkAlerts(db, project).filter((a) => a.kind === 'unpriced');
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.message, /brand-new-model/);
  });

  test('requests over the context ceiling are flagged', () => {
    const { db, project } = sandbox();
    req(db, project, { session: 'big', hoursAgo: 1, usd: 1, cacheRead: 800_000 });
    const hits = checkAlerts(db, project).filter((a) => a.kind === 'context');
    assert.equal(hits.length, 1);
  });

  test('alerts come back worst first', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    req(db, project, { session: 'bad', hoursAgo: 1, usd: 12 });
    req(db, project, { session: 'worse', hoursAgo: 1, usd: 40 });
    const hits = runaways(db, project);
    assert.ok(
      hits[0]!.severity > hits[1]!.severity,
      'a capped list showing arbitrary rows would be worse than no list',
    );
  });

  test('a quiet project raises nothing', () => {
    const { db, project } = sandbox();
    baseline(db, project, 10, 4);
    assert.equal(checkAlerts(db, project).length, 0);
  });
});
