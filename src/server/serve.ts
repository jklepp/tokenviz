import http from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../store/db.ts';
import { listProjects, type Project } from '../store/projects.ts';
import { costSummary } from '../pricing/cost.ts';
import { buildDashboard, buildSettings } from '../report/dashboard.ts';
import { buildMessages } from '../report/messages.ts';
import { dashboardPage, messagesPage, projectsPage, settingsPage } from './views.ts';

/**
 * A local, read-mostly web front end.
 *
 * It binds to loopback only. The store spans every project on the machine,
 * including private ones, so the default must never be a port anyone else can
 * reach.
 */

const RATE_FIELDS = ['input', 'output', 'cw5m', 'cw1h', 'read'] as const;

function projectBySlug(db: DatabaseSync, slug: string): Project | null {
  return listProjects(db).find((p) => p.slug === slug) ?? null;
}

function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Apply edited rates.
 *
 * With no date, the card currently in force is edited in place. With one, a new
 * card is written effective from that date -- which is the deliberate,
 * separate action that correcting the past is supposed to be. Either way the
 * total is measured before and after so the change is reported rather than
 * happening silently.
 */
export function saveRates(
  db: DatabaseSync,
  project: Project,
  form: URLSearchParams,
): { text: string; warn?: boolean } {
  const before = costSummary(db, project).totalUSD;
  const validFrom = (form.get('valid_from') ?? '').trim();
  const effective = validFrom ? `${validFrom}T00:00:00Z` : null;

  const models = new Set<string>();
  for (const key of form.keys()) {
    const idx = key.indexOf(':');
    if (idx > 0 && (RATE_FIELDS as readonly string[]).includes(key.slice(0, idx))) {
      models.add(key.slice(idx + 1));
    }
  }
  if (models.size === 0) return { text: 'Nothing to save.', warn: true };

  const num = (k: string): number | null => {
    const v = form.get(k);
    if (v === null || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  db.exec('BEGIN');
  try {
    for (const model of models) {
      const rates = {
        input: num(`input:${model}`),
        output: num(`output:${model}`),
        cw5m: num(`cw5m:${model}`),
        cw1h: num(`cw1h:${model}`),
        read: num(`read:${model}`),
      };
      if (Object.values(rates).some((v) => v === null)) continue;

      if (effective) {
        db.prepare(
          `INSERT INTO rate_card (model, valid_from, input_per_mtok, output_per_mtok,
             cache_write_5m_per_mtok, cache_write_1h_per_mtok, cache_read_per_mtok,
             source, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'edited-in-settings', ?, ?)
           ON CONFLICT(model, valid_from) DO UPDATE SET
             input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok,
             cache_write_5m_per_mtok = excluded.cache_write_5m_per_mtok,
             cache_write_1h_per_mtok = excluded.cache_write_1h_per_mtok,
             cache_read_per_mtok = excluded.cache_read_per_mtok,
             source = 'edited-in-settings', note = excluded.note`,
        ).run(
          model, effective, rates.input, rates.output, rates.cw5m, rates.cw1h, rates.read,
          `backdated correction entered ${nowIso().slice(0, 10)}`, nowIso(),
        );
      } else {
        db.prepare(
          `UPDATE rate_card SET input_per_mtok = ?, output_per_mtok = ?,
             cache_write_5m_per_mtok = ?, cache_write_1h_per_mtok = ?, cache_read_per_mtok = ?,
             source = 'edited-in-settings'
           WHERE model = ? AND valid_from = (
             SELECT MAX(valid_from) FROM rate_card WHERE model = ?)`,
        ).run(rates.input, rates.output, rates.cw5m, rates.cw1h, rates.read, model, model);
      }

      const ctx = num(`ctx:${model}`);
      if (ctx !== null) {
        db.prepare(
          `INSERT INTO model_setting (model, context_window, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(model) DO UPDATE SET context_window = excluded.context_window,
             updated_at = excluded.updated_at`,
        ).run(model, Math.round(ctx), nowIso());
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { text: `Nothing saved: ${(err as Error).message}`, warn: true };
  }

  const after = costSummary(db, project).totalUSD;
  const delta = after - before;
  const moved =
    Math.abs(delta) < 0.005
      ? 'Total is unchanged.'
      : `Total moved ${delta > 0 ? 'up' : 'down'} by $${Math.abs(delta).toFixed(2)}, ` +
        `from $${before.toFixed(2)} to $${after.toFixed(2)}.`;

  return {
    text: effective
      ? `Backdated card written effective ${validFrom}. Only requests on or after that date were re-costed. ${moved}`
      : `Current rates saved. ${moved}`,
    warn: Math.abs(delta) > before * 0.25,
  };
}

export type ServeOptions = { port: number; host?: string };

export function serve(db: DatabaseSync, opts: ServeOptions): http.Server {
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${host}`);
      const send = (code: number, html: string) => {
        res.writeHead(code, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        });
        res.end(html);
      };

      try {
        const parts = url.pathname.split('/').filter(Boolean);

        if (parts.length === 0) {
          const rows = listProjects(db).map((p) => ({
            slug: p.slug,
            repo: p.github_repo,
            requests: (
              db.prepare('SELECT COUNT(*) n FROM request WHERE project_id = ?').get(p.id) as { n: number }
            ).n,
          }));
          return send(200, projectsPage(rows));
        }

        if (parts[0] === 'p' && parts[1]) {
          const project = projectBySlug(db, decodeURIComponent(parts[1]));
          if (!project) return send(404, projectsPage([]));

          if (parts[2] === 'messages') {
            // A cell is selected by the pair naming it, so a view of one edge
            // is a URL that can be kept and shared rather than a click that
            // cannot be got back to.
            const from = url.searchParams.get('from');
            const to = url.searchParams.get('to');
            const select = from && to ? { from, to } : null;
            return send(200, messagesPage(buildMessages(db, project, select)));
          }

          if (parts[2] === 'settings') {
            if (req.method === 'POST') {
              const form = new URLSearchParams(await readBody(req));
              const flash = saveRates(db, project, form);
              return send(200, settingsPage(buildSettings(db, project), flash));
            }
            return send(200, settingsPage(buildSettings(db, project)));
          }

          return send(200, dashboardPage(buildDashboard(db, project)));
        }

        return send(404, projectsPage(listProjects(db).map((p) => ({ slug: p.slug, repo: p.github_repo, requests: 0 }))));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`tokenviz: ${(err as Error).message}`);
      }
    })();
  });

  server.listen(opts.port, host);
  return server;
}
