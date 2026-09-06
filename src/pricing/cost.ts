import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import type { Project } from '../store/projects.ts';
import type { SolvedRate } from './solve.ts';
import { CARD_JOIN, COST_EXPR, COST_SUM, NO_CARD_PREDICATE } from './models.ts';

export { COST_EXPR, COST_SUM, CARD_JOIN } from './models.ts';

/**
 * Turning tokens into API-equivalent dollars.
 *
 * A request is costed by the rate card in force at its own timestamp, so a
 * price change shows up as a step in the series rather than silently rewriting
 * what last month cost. See docs/adr/0002.
 */

/**
 * Decimal places a rate is stored and displayed at. Cache read is the reason
 * this is not 2: it is a small number multiplied by billions of tokens, so a
 * hundredth of a cent per million moves the total by dollars.
 */
export const RATE_DECIMALS = 4;

export type Card = {
  id: number;
  model: string;
  valid_from: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_5m_per_mtok: number;
  cache_write_1h_per_mtok: number;
  cache_read_per_mtok: number;
  source: string;
  note: string | null;
};

export function listCards(db: DatabaseSync): Card[] {
  return db
    .prepare('SELECT * FROM rate_card ORDER BY model, valid_from')
    .all() as unknown as Card[];
}

/**
 * Write a card per solved model. Only corroborated fits are written: an
 * uncorroborated one is a guess, and a guessed rate that silently becomes the
 * source of truth is worse than a visible gap.
 */
export function writeCards(
  db: DatabaseSync,
  solved: SolvedRate[],
  validFrom: string,
  source = 'solved-from-cost-state',
): { written: number; skipped: string[] } {
  const insert = db.prepare(
    `INSERT INTO rate_card (
       model, valid_from, input_per_mtok, output_per_mtok,
       cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok,
       source, note, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model, valid_from) DO UPDATE SET
       input_per_mtok = excluded.input_per_mtok,
       output_per_mtok = excluded.output_per_mtok,
       cache_write_5m_per_mtok = excluded.cache_write_5m_per_mtok,
       cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
       cache_read_per_mtok = excluded.cache_read_per_mtok,
       source = excluded.source, note = excluded.note`,
  );

  // Round to the precision the settings page shows. If storage carried more
  // precision than the form, opening settings and saving an unchanged page
  // would move the total -- a no-op that is not a no-op.
  const r4 = (n: number) => Number(n.toFixed(RATE_DECIMALS));

  let written = 0;
  const skipped: string[] = [];
  for (const s of solved) {
    if (!s.rates) {
      skipped.push(`${s.model}: ${s.note ?? 'no fit'}`);
      continue;
    }
    insert.run(
      s.model, validFrom, r4(s.rates.inputPerMTok), r4(s.rates.outputPerMTok),
      r4(s.rates.cacheWrite5mPerMTok), r4(s.rates.cacheWrite1hPerMTok), r4(s.rates.cacheReadPerMTok),
      s.corroborated ? source : `${source}-uncorroborated`,
      `fit over ${s.sessions} billed sessions, median error ${(s.medianRelError * 100).toFixed(1)}%` +
        (s.corroborated ? '' : `; ${s.note}`),
      nowIso(),
    );
    written += 1;
  }
  return { written, skipped };
}

/**
 * Point every recorded model name at a card. An exact match wins; otherwise a
 * context-tier suffix is tried, because transcripts record the bare alias while
 * billing records the tier. Anything still unmatched is left alone and shows up
 * as uncosted rather than being priced by a neighbouring card.
 */
export function seedAliases(db: DatabaseSync, project: Project): { alias: string; to: string }[] {
  const models = db
    .prepare('SELECT DISTINCT model FROM request WHERE project_id = ? AND model IS NOT NULL')
    .all(project.id) as unknown as { model: string }[];
  const cards = new Set(listCards(db).map((c) => c.model));

  const insert = db.prepare(
    `INSERT INTO model_alias (request_model, card_model, reason, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(request_model) DO NOTHING`,
  );

  const made: { alias: string; to: string }[] = [];
  for (const { model } of models) {
    if (cards.has(model)) continue;
    const tiered = `${model}[1m]`;
    if (cards.has(tiered)) {
      insert.run(model, tiered, 'transcripts record the bare alias; billing records the 1M tier', nowIso());
      made.push({ alias: model, to: tiered });
    }
  }
  return made;
}

/**
 * Cost is a computed join, never a stored column: rates are effective-dated,
 * so the same request re-costs correctly when a card is corrected. The join
 * itself lives in models.ts, which owns model-to-card resolution.
 */

const COSTED_FROM = `FROM request r ${CARD_JOIN} WHERE r.project_id = ?`;

export type CostSummary = {
  costedRequests: number;
  uncostedRequests: number;
  totalUSD: number;
  uncostedModels: { model: string | null; requests: number }[];
};

export function costSummary(db: DatabaseSync, project: Project, until?: string): CostSummary {
  const dayClause = until ? ' AND r.day <= ?' : '';
  const args = until ? [project.id, until] : [project.id];

  const costed = db
    .prepare(`SELECT COUNT(*) n, ${COST_SUM} total ${COSTED_FROM}${dayClause}`)
    .get(...args) as { n: number; total: number };

  const uncosted = db
    .prepare(
      `SELECT r.model, COUNT(*) n FROM request r
        WHERE r.project_id = ?${until ? ' AND r.day <= ?' : ''}
          AND ${NO_CARD_PREDICATE}
        GROUP BY r.model ORDER BY n DESC`,
    )
    .all(...args) as unknown as { model: string | null; n: number }[];

  return {
    costedRequests: costed.n,
    uncostedRequests: uncosted.reduce((s, u) => s + u.n, 0),
    totalUSD: costed.total,
    uncostedModels: uncosted.map((u) => ({ model: u.model, requests: u.n })),
  };
}

export function costByModel(db: DatabaseSync, project: Project) {
  return db
    .prepare(
      `SELECT r.model, COUNT(*) requests, ${COST_SUM} usd ${COSTED_FROM}
        GROUP BY r.model ORDER BY usd DESC`,
    )
    .all(project.id) as unknown as { model: string; requests: number; usd: number }[];
}

export function costBySlot(db: DatabaseSync, project: Project) {
  return db
    .prepare(
      `SELECT r.slot, COUNT(*) requests, ${COST_SUM} usd ${COSTED_FROM}
        GROUP BY r.slot ORDER BY usd DESC`,
    )
    .all(project.id) as unknown as { slot: string; requests: number; usd: number }[];
}

/**
 * Compare what we compute against what Claude Code billed, per session.
 *
 * This is the standing check that a card has not gone stale and that no new
 * model has appeared unpriced. It cannot be exact -- billing counts usage the
 * transcripts never recorded -- so the useful signal is the shape of the
 * difference, not its absence.
 */
export type Reconciliation = {
  sessions: number;
  computedUSD: number;
  billedUSD: number;
  medianRelError: number;
  worst: { session: string; computed: number; billed: number }[];
};

export function reconcile(db: DatabaseSync, project: Project, worstN = 5): Reconciliation {
  const rows = db
    .prepare(
      `SELECT r.session, ${COST_SUM} computed
         ${COSTED_FROM}
        GROUP BY r.session`,
    )
    .all(project.id) as unknown as { session: string; computed: number }[];

  const billed = new Map(
    (
      db
        .prepare('SELECT session, total_cost_usd FROM session_cost WHERE project_id = ? AND total_cost_usd > 0')
        .all(project.id) as unknown as { session: string; total_cost_usd: number }[]
    ).map((r) => [r.session, r.total_cost_usd]),
  );

  let computedTotal = 0;
  let billedTotal = 0;
  const errors: number[] = [];
  const pairs: { session: string; computed: number; billed: number }[] = [];

  for (const r of rows) {
    const b = billed.get(r.session);
    if (b === undefined) continue;
    computedTotal += r.computed;
    billedTotal += b;
    errors.push(Math.abs(r.computed - b) / b);
    pairs.push({ session: r.session, computed: r.computed, billed: b });
  }

  errors.sort((a, b) => a - b);
  pairs.sort((a, b) => Math.abs(b.computed - b.billed) - Math.abs(a.computed - a.billed));

  return {
    sessions: pairs.length,
    computedUSD: computedTotal,
    billedUSD: billedTotal,
    medianRelError: errors[Math.floor(errors.length / 2)] ?? NaN,
    worst: pairs.slice(0, worstN),
  };
}
