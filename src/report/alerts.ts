import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../store/projects.ts';
import { CARD_JOIN, COST_SUM, NO_CARD_PREDICATE } from '../pricing/models.ts';

/**
 * Standing checks, printed wherever ingest already runs.
 *
 * There is no daemon and no notification: these are warnings on stdout from a
 * command you were running anyway. The point is that a regression should be
 * impossible to miss while you are looking, not that you should be paged.
 *
 * Baselines are trailing medians rather than means, and are computed per slot.
 * A mean hides exactly the runaway session these exist to catch, and one global
 * baseline across slots would either never fire or fire constantly, because a
 * CEO session and a coder session have structurally different cost profiles.
 */

export type Alert = {
  kind: 'runaway' | 'cache-drop' | 'unpriced' | 'drift' | 'context';
  message: string;
  detail?: string;
  /** How far past its threshold this is, for ordering. Higher is worse. */
  severity: number;
};

export type AlertOptions = {
  /** Days of history the baseline is drawn from. */
  baselineDays: number;
  /** How recent a session must be to be checked against that baseline. */
  recentHours: number;
  /** How many times the baseline a session may cost before it is flagged. */
  runawayMultiple: number;
  /** Percentage points the cache hit rate may fall before it is flagged. */
  cacheDropPoints: number;
  /** Context size at which a request is considered to have hit the ceiling. */
  contextCeiling: number;
  /** Sessions a slot's baseline needs before it is trusted to judge anything. */
  minBaselineSessions: number;
  /** A session cheaper than this is never worth a warning, whatever the ratio. */
  minSessionUSD: number;
};

export const DEFAULT_ALERT_OPTIONS: AlertOptions = {
  // Fourteen days is a compromise, not a principle: the corpus is not much
  // older than that. Lengthen it once there is more history to draw on.
  baselineDays: 14,
  recentHours: 24,
  runawayMultiple: 2,
  cacheDropPoints: 5,
  // Commander's own circuit breaker, from .claude/hooks/check-context-size.mjs.
  contextCeiling: 700_000,
  minBaselineSessions: 8,
  minSessionUSD: 2,
};


function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function checkAlerts(
  db: DatabaseSync,
  project: Project,
  opts: AlertOptions = DEFAULT_ALERT_OPTIONS,
): Alert[] {
  const alerts: Alert[] = [];
  const now = Date.now();
  const baselineFrom = new Date(now - opts.baselineDays * 86400000).toISOString();
  const recentFrom = new Date(now - opts.recentHours * 3600000).toISOString();

  const hasCards =
    (db.prepare('SELECT COUNT(*) n FROM rate_card').get() as { n: number }).n > 0;

  // --- Runaway sessions -------------------------------------------------
  if (hasCards) {
    // Console sessions only. A subagent transcript is a separate session row
    // but is not a separate *run* -- its work was dispatched by a console and
    // its cost belongs there. Counting them dragged one slot's median to $0.27
    // and made every real session look like a 20x runaway.
    const sessions = db
      .prepare(
        `SELECT r.session, r.slot, MAX(r.ts) last_ts, ${COST_SUM} usd
           FROM request r ${CARD_JOIN}
          WHERE r.project_id = ? AND r.ts >= ? AND r.origin = 'console'
          GROUP BY r.session, r.slot`,
      )
      .all(project.id, baselineFrom) as unknown as {
      session: string;
      slot: string;
      last_ts: string;
      usd: number;
    }[];

    const bySlot = new Map<string, number[]>();
    for (const s of sessions) {
      if (s.last_ts >= recentFrom) continue; // baseline excludes what it judges
      bySlot.set(s.slot, [...(bySlot.get(s.slot) ?? []), s.usd]);
    }

    for (const s of sessions) {
      if (s.last_ts < recentFrom) continue;
      if (s.usd < opts.minSessionUSD) continue;
      const sample = bySlot.get(s.slot) ?? [];
      if (sample.length < opts.minBaselineSessions) continue;
      const base = median(sample);
      if (base === null || base <= 0) continue;
      const ratio = s.usd / base;
      if (ratio >= opts.runawayMultiple) {
        alerts.push({
          kind: 'runaway',
          message: `${s.slot} session cost ${usd(s.usd)}, ${ratio.toFixed(1)}x its ${opts.baselineDays}-day median of ${usd(base)}`,
          detail: s.session,
          severity: ratio,
        });
      }
    }
  }

  // --- Cache hit rate ---------------------------------------------------
  const cacheRow = (from: string, to?: string) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(input + cache_write + cache_read),0) ctx
           FROM request WHERE project_id = ? AND ts >= ?${to ? ' AND ts < ?' : ''}`,
      )
      .get(...(to ? [project.id, from, to] : [project.id, from])) as { cr: number; ctx: number };

  const base = cacheRow(baselineFrom, recentFrom);
  const recent = cacheRow(recentFrom);
  if (base.ctx > 0 && recent.ctx > 0) {
    const bp = (base.cr / base.ctx) * 100;
    const rp = (recent.cr / recent.ctx) * 100;
    if (bp - rp >= opts.cacheDropPoints) {
      alerts.push({
        kind: 'cache-drop',
        message: `cache hit rate fell to ${rp.toFixed(1)}% from a ${opts.baselineDays}-day baseline of ${bp.toFixed(1)}%`,
        detail: 'a drop this size usually means a prompt or tool schema changed and broke the cached prefix',
        severity: 100 + (bp - rp),
      });
    }
  }

  // --- Context ceiling --------------------------------------------------
  const ceiling = db
    .prepare(
      `SELECT COUNT(*) n FROM request
        WHERE project_id = ? AND ts >= ? AND (input + cache_write + cache_read) >= ?`,
    )
    .get(project.id, recentFrom, opts.contextCeiling) as { n: number };
  if (ceiling.n > 0) {
    alerts.push({
      kind: 'context',
      message: `${ceiling.n} request(s) at or above the ${(opts.contextCeiling / 1000).toFixed(0)}K context ceiling in the last ${opts.recentHours}h`,
      severity: 50,
    });
  }

  // --- Models with no card ----------------------------------------------
  const unpriced = db
    .prepare(
      `SELECT r.model, COUNT(*) n FROM request r
        WHERE r.project_id = ? AND r.model IS NOT NULL
          AND ${NO_CARD_PREDICATE}
        GROUP BY r.model ORDER BY n DESC`,
    )
    .all(project.id) as unknown as { model: string; n: number }[];
  for (const u of unpriced) {
    alerts.push({
      kind: 'unpriced',
      message: `${u.model} has no rate card; its ${u.n.toLocaleString()} request(s) are excluded from every cost figure`,
      severity: 60,
    });
  }

  // --- Drift against Claude Code's own billing --------------------------
  if (hasCards) {
    const computed = db
      .prepare(
        `SELECT r.session, ${COST_SUM} usd FROM request r ${CARD_JOIN}
          WHERE r.project_id = ? GROUP BY r.session`,
      )
      .all(project.id) as unknown as { session: string; usd: number }[];
    const billed = new Map(
      (
        db
          .prepare('SELECT session, total_cost_usd FROM session_cost WHERE project_id = ? AND total_cost_usd > 0')
          .all(project.id) as unknown as { session: string; total_cost_usd: number }[]
      ).map((r) => [r.session, r.total_cost_usd]),
    );
    const errs: number[] = [];
    for (const c of computed) {
      const b = billed.get(c.session);
      if (b !== undefined && b > 0) errs.push(Math.abs(c.usd - b) / b);
    }
    const med = median(errs);
    if (med !== null && med > 0.1) {
      alerts.push({
        kind: 'drift',
        message: `computed cost differs from Claude Code's own billing by ${(med * 100).toFixed(0)}% at the median session`,
        detail: 'the rate cards are probably stale, or a model is being priced by the wrong card',
        severity: 200,
      });
    }
  }

  // Worst first: a capped list that shows arbitrary rows is worse than no list.
  return alerts.sort((a, b) => b.severity - a.severity);
}

export function formatAlerts(alerts: Alert[]): string[] {
  if (alerts.length === 0) return ['alerts   none'];
  const lines = [`alerts   ${alerts.length} warning(s), worst first`];
  for (const a of alerts.slice(0, 8)) {
    lines.push(`  ! ${a.message}`);
    if (a.detail) lines.push(`      ${a.detail}`);
  }
  if (alerts.length > 8) lines.push(`  ... and ${alerts.length - 8} more`);
  return lines;
}
