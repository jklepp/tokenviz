import type { DatabaseSync } from 'node:sqlite';

/**
 * The one place that knows which rate card prices a recorded model.
 *
 * Transcripts record `claude-opus-5` while billing records
 * `claude-opus-5[1m]`, the 1M-context tier at different rates, so the two names
 * for the same traffic must be reconciled before any cost question can be
 * asked. Getting that wrong is silent: the join simply matches nothing, the
 * category is priced at zero, and the total comes out low but plausible.
 *
 * That has already happened twice -- once in an ad-hoc analysis that appeared
 * to show a 16% under-price, and once latently in the rate solver, where a
 * missing tier mix fell back to a flat 2x. Both were invisible until checked
 * against an independent figure. Hence one owner, used everywhere, rather than
 * the same join rewritten at each call site.
 */

/** A model name with any context-tier suffix removed: `x[1m]` becomes `x`. */
export function baseModel(name: string): string {
  return name.replace(/\[[^\]]*\]$/, '');
}

/** Which card prices this recorded model: an explicit alias, or itself. */
export function cardModelFor(db: DatabaseSync, requestModel: string): string {
  const row = db
    .prepare('SELECT card_model FROM model_alias WHERE request_model = ?')
    .get(requestModel) as { card_model: string } | undefined;
  return row?.card_model ?? requestModel;
}

/**
 * Every name a card's traffic might be recorded under.
 *
 * Aliases are the reliable answer, but they are seeded only after cards are
 * written, so the tier-stripped name is included as well. That is what lets
 * the solver find `claude-opus-5` request rows for a `claude-opus-5[1m]` card
 * on the very first run, before any alias exists.
 */
export function requestModelsFor(db: DatabaseSync, cardModel: string): string[] {
  const rows = db
    .prepare('SELECT request_model FROM model_alias WHERE card_model = ?')
    .all(cardModel) as unknown as { request_model: string }[];
  return [...new Set([cardModel, baseModel(cardModel), ...rows.map((r) => r.request_model)])];
}

/**
 * The canonical join from a `request r` to the `rate_card c` in force at its
 * own timestamp. Every cost query uses this; none should rewrite it.
 */
export const CARD_JOIN = `
  LEFT JOIN model_alias a ON a.request_model = r.model
  JOIN rate_card c
    ON c.model = COALESCE(a.card_model, r.model)
   AND c.valid_from = (SELECT MAX(c2.valid_from) FROM rate_card c2
                        WHERE c2.model = c.model AND c2.valid_from <= r.ts)`;

/**
 * Whether a request has any card at all. The negation of the join above, kept
 * beside it so the two cannot drift apart.
 */
export const NO_CARD_PREDICATE = `
  NOT EXISTS (
    SELECT 1 FROM rate_card c
     LEFT JOIN model_alias a ON a.request_model = r.model
     WHERE c.model = COALESCE(a.card_model, r.model) AND c.valid_from <= r.ts)`;

/**
 * Cost of one request, in dollars.
 *
 * A cache write with no tier recorded is charged at the 1-hour rate, the more
 * expensive of the two, so an unknown never flatters the total.
 */
export const COST_EXPR = `
  (r.input       / 1000000.0) * c.input_per_mtok
+ (r.output      / 1000000.0) * c.output_per_mtok
+ (r.cache_read  / 1000000.0) * c.cache_read_per_mtok
+ (r.cache_write_5m / 1000000.0) * c.cache_write_5m_per_mtok
+ (MAX(r.cache_write - r.cache_write_5m, 0) / 1000000.0) * c.cache_write_1h_per_mtok`;

/** `SUM` of {@link COST_EXPR}, zero rather than null when nothing matches. */
export const COST_SUM = `COALESCE(SUM(${COST_EXPR}), 0)`;

export const CACHE_WRITE_5M_RATIO = 1.25;
export const CACHE_WRITE_1H_RATIO = 2.0;

/**
 * The split of a card's cache writes between the 5-minute and 1-hour tiers,
 * resolved through the alias so a tiered card finds its own traffic.
 *
 * With no traffic at all the blend falls back to the 1-hour rate: assuming the
 * more expensive tier keeps an unknown from flattering a rate.
 */
export function cacheWriteMix(
  db: DatabaseSync,
  projectId: number,
  cardModel?: string,
): { m5: number; m1h: number; blend: number } {
  let sql =
    `SELECT COALESCE(SUM(cache_write_5m),0) m5, COALESCE(SUM(cache_write_1h),0) m1h
       FROM request WHERE project_id = ?`;
  const args: (string | number)[] = [projectId];

  if (cardModel !== undefined) {
    const names = requestModelsFor(db, cardModel);
    sql += ` AND model IN (${names.map(() => '?').join(',')})`;
    args.push(...names);
  }

  const r = db.prepare(sql).get(...args) as { m5: number; m1h: number };
  const total = r.m5 + r.m1h;
  if (total === 0) return { m5: 0, m1h: 1, blend: CACHE_WRITE_1H_RATIO };
  const m5 = r.m5 / total;
  const m1h = r.m1h / total;
  return { m5, m1h, blend: m5 * CACHE_WRITE_5M_RATIO + m1h * CACHE_WRITE_1H_RATIO };
}
