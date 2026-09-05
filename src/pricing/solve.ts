import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../store/projects.ts';

/**
 * Recovering per-model rates from Claude Code's own billing.
 *
 * Every `cost-state` record states what one session cost on one model,
 * alongside the exact token counts that produced it. That is a linear equation
 * per session, and with hundreds of sessions per model the rates are
 * recoverable by least squares.
 *
 * Fitting all four token categories does not work, and the reason is worth
 * recording: input is around 239K tokens against 13.1B of cache read, so its
 * column carries almost no signal and the solver hands it a large negative
 * coefficient to absorb noise elsewhere. Dropping it leaves three
 * well-conditioned columns that fit to roughly 2% median error.
 *
 * The input rate is then recovered structurally rather than fitted: Anthropic
 * prices cache reads at a tenth of input, and the fitted cache-read rate has
 * 13.1B tokens of signal behind it. The corroboration is that the fitted
 * cache-write rate then lands on the blend the observed 5m/1h tier mix
 * predicts, which nothing in the fit forced it to do.
 *
 * These rates are a *seed* for a hand-maintained card, not the source of
 * truth. See docs/adr/0002.
 */

/** Anthropic prices cache reads at a tenth of the input rate. */
export const CACHE_READ_RATIO = 0.1;
/** A five-minute cache write costs 1.25x input; a one-hour write costs 2x. */
export const CACHE_WRITE_5M_RATIO = 1.25;
export const CACHE_WRITE_1H_RATIO = 2.0;

export type Observation = { x: number[]; y: number };

/**
 * Ordinary least squares by normal equations with partial pivoting.
 * Returns null when the system is singular -- too few observations, or
 * columns that do not vary independently.
 */
export function leastSquares(obs: Observation[], k: number): number[] | null {
  if (obs.length < k) return null;

  const m: number[][] = Array.from({ length: k }, () => new Array<number>(k + 1).fill(0));
  for (const { x, y } of obs) {
    for (let i = 0; i < k; i++) {
      const xi = x[i] ?? 0;
      for (let j = 0; j < k; j++) m[i]![j]! += xi * (x[j] ?? 0);
      m[i]![k]! += xi * y;
    }
  }

  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) {
      if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    }
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];

    const p = m[col]![col]!;
    for (let j = col; j <= k; j++) m[col]![j]! /= p;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (f === 0) continue;
      for (let j = col; j <= k; j++) m[r]![j]! -= f * m[col]![j]!;
    }
  }

  return m.map((row) => row[k]!);
}

export type Rates = {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
};

export type SolvedRate = {
  model: string;
  sessions: number;
  rates: Rates | null;
  /** Cache-write rate as fitted, before the tier split was imposed. */
  fittedCacheWrite: number | null;
  /** What the observed 5m/1h mix predicts that blended rate should be. */
  predictedCacheWrite: number | null;
  /** Whether those two agree, which is the only independent check available. */
  corroborated: boolean;
  actualTotal: number;
  maxRelError: number;
  medianRelError: number;
  note: string | null;
};

type Row = { input: number; output: number; cache_write: number; cache_read: number; cost_usd: number };

const MTOK = 1_000_000;

/** The observed split of cache writes between the 5-minute and 1-hour tiers. */
export function cacheWriteMix(db: DatabaseSync, project: Project): { m5: number; m1h: number } {
  const r = db
    .prepare('SELECT COALESCE(SUM(cache_write_5m),0) m5, COALESCE(SUM(cache_write_1h),0) m1h FROM request WHERE project_id = ?')
    .get(project.id) as { m5: number; m1h: number };
  const total = r.m5 + r.m1h;
  return total === 0 ? { m5: 0, m1h: 1 } : { m5: r.m5 / total, m1h: r.m1h / total };
}

export function solveRates(db: DatabaseSync, project: Project, minSessions = 8): SolvedRate[] {
  const mix = cacheWriteMix(db, project);
  const blendRatio = mix.m5 * CACHE_WRITE_5M_RATIO + mix.m1h * CACHE_WRITE_1H_RATIO;

  const models = db
    .prepare('SELECT DISTINCT model FROM session_model_cost WHERE project_id = ? ORDER BY model')
    .all(project.id) as unknown as { model: string }[];

  const out: SolvedRate[] = [];

  for (const { model } of models) {
    const rows = db
      .prepare(
        `SELECT input, output, cache_write, cache_read, cost_usd
           FROM session_model_cost
          WHERE project_id = ? AND model = ? AND cost_usd > 0`,
      )
      .all(project.id, model) as unknown as Row[];

    const actualTotal = rows.reduce((s, r) => s + r.cost_usd, 0);
    const base = {
      model, sessions: rows.length, rates: null, fittedCacheWrite: null,
      predictedCacheWrite: null, corroborated: false, actualTotal,
      maxRelError: NaN, medianRelError: NaN,
    };

    if (rows.length < minSessions) {
      out.push({ ...base, note: `only ${rows.length} billed session(s); needs ${minSessions}` });
      continue;
    }

    // Three columns: output, cache write, cache read. Input is excluded
    // deliberately -- see the note at the top of this file.
    const obs: Observation[] = rows.map((r) => ({
      x: [r.output / MTOK, r.cache_write / MTOK, r.cache_read / MTOK],
      y: r.cost_usd,
    }));

    const solution = leastSquares(obs, 3);
    if (!solution) {
      out.push({ ...base, note: 'singular; token categories do not vary independently' });
      continue;
    }

    const [output, cacheWrite, cacheRead] = solution as [number, number, number];
    if (cacheRead <= 0 || output <= 0) {
      out.push({ ...base, note: 'fit is not physical; a negative rate means the model is wrong' });
      continue;
    }

    const inputRate = cacheRead / CACHE_READ_RATIO;

    const errors: number[] = [];
    for (const o of obs) {
      const fitted = o.x.reduce((s, xi, i) => s + xi * solution[i]!, 0);
      if (o.y > 0) errors.push(Math.abs(fitted - o.y) / o.y);
    }
    errors.sort((a, b) => a - b);

    // The fitted cache-write rate was never constrained to agree with the tier
    // mix, so agreement is real corroboration that the derived input rate is
    // right. Disagreement means it is not, and the model needs a hand-set card.
    const predicted = inputRate * blendRatio;
    const drift = Math.abs(cacheWrite - predicted) / predicted;
    const corroborated = drift <= 0.15;

    out.push({
      model,
      sessions: rows.length,
      rates: {
        inputPerMTok: inputRate,
        outputPerMTok: output,
        cacheWrite5mPerMTok: inputRate * CACHE_WRITE_5M_RATIO,
        cacheWrite1hPerMTok: inputRate * CACHE_WRITE_1H_RATIO,
        cacheReadPerMTok: cacheRead,
      },
      fittedCacheWrite: cacheWrite,
      predictedCacheWrite: predicted,
      corroborated,
      actualTotal,
      maxRelError: errors.at(-1) ?? NaN,
      medianRelError: errors[Math.floor(errors.length / 2)] ?? NaN,
      note: corroborated
        ? null
        : `cache-write rate is ${(drift * 100).toFixed(0)}% off the tier mix; the derived input rate is unreliable, set this model by hand`,
    });
  }

  return out;
}
