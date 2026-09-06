#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDb, storePath } from './store/db.ts';
import { listProjects, registerProject } from './store/projects.ts';
import { repoSlug } from './sources/gh.ts';
import { ingestActions } from './ingest/actions.ts';
import { ingestGitHistory } from './ingest/gitHistory.ts';
import { ingestTranscripts } from './ingest/transcripts.ts';
import { ingestPulls } from './ingest/pulls.ts';
import { annotatePulls, reconstructTasks, summariseTasks, taskMetrics } from './adapters/commander/tasks.ts';
import { captureLedger, ledgerPath, ledgerStats } from './adapters/commander/ledger.ts';
import { serve } from './server/serve.ts';
import { byModel, byOrigin, bySlot, cacheHitRate, human, totals } from './report/usage.ts';
import { checkAlerts, formatAlerts } from './report/alerts.ts';
import { solveRates } from './pricing/solve.ts';
import { costSummary, listCards, reconcile, seedAliases, writeCards } from './pricing/cost.ts';
import {
  DEFAULT_COMMANDER_CONFIG,
  failedSteps,
  listPromotions,
  summarise,
} from './adapters/commander/promotions.ts';

const USAGE = `tokenviz — FinOps metrics for agentic development

  tokenviz ingest      [--project <path>] [--adapter <name>]
  tokenviz usage       [--project <path>]
  tokenviz rates       [--project <path>] [--write] [--from <ISO date>]
  tokenviz tasks       [--project <path>] [--worst <n>]
  tokenviz watch       [--project <path>] [--interval <seconds>]
  tokenviz serve       [--port <n>]
  tokenviz promotions  [--project <path>] [--steps]
  tokenviz projects

Store: ${storePath()}  (override with TOKENVIZ_HOME)
`;

const out = (s: string) => process.stdout.write(s + '\n');

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      adapter: { type: 'string' },
      steps: { type: 'boolean', default: false },
      worst: { type: 'string' },
      interval: { type: 'string' },
      port: { type: 'string' },
      write: { type: 'boolean', default: false },
      from: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const db = openDb();
  const projectPath = resolve(values.project ?? process.cwd());

  switch (command) {
    case 'ingest': {
      const slug = repoSlug(projectPath);
      const project = registerProject(db, {
        rootPath: projectPath,
        githubRepo: slug,
        adapter: values.adapter ?? null,
      });
      out(`project  ${project.slug}  (${project.github_repo ?? 'no GitHub remote'})`);

      const git = ingestGitHistory(db, project);
      out(`git      ${git.seen} first-parent commits on ${git.branch}, ${git.inserted} new`);

      if (project.github_repo) {
        const actions = ingestActions(db, project);
        out(`actions  ${actions.seen} runs seen, ${actions.inserted} new`);
        const pulls = ingestPulls(db, project);
        const ann = annotatePulls(db, project);
        out(
          `pulls    ${pulls.seen} PRs seen, ${pulls.inserted} new; ` +
            `${ann.annotated} carry a slot in the branch, ${ann.unmatched} do not`,
        );
      } else {
        out('actions  skipped (no GitHub remote)');
      }

      const t = ingestTranscripts(db, project);
      out(
        `sessions ${t.filesSeen} transcripts: ${t.filesUnchanged} unchanged, ` +
          `${t.filesResumed} resumed, ${t.filesRescanned} rescanned` +
          (t.filesFailed > 0 ? `, ${t.filesFailed} failed` : ''),
      );
      out(
        `         ${t.linesRead.toLocaleString()} lines read, ` +
          `${t.requestsInserted.toLocaleString()} new requests, ` +
          `${t.eventsInserted.toLocaleString()} events, ${t.costStates} cost-state records`,
      );
      for (const line of formatAlerts(checkAlerts(db, project))) out(line);
      return 0;
    }

    case 'usage': {
      const project = registerProject(db, { rootPath: projectPath });
      const t = totals(db, project);
      if (t.requests === 0) {
        out('No requests ingested. Run `tokenviz ingest` first.');
        return 1;
      }
      const hit = cacheHitRate(t);
      out('');
      out(`${project.slug}  ${t.firstDay} to ${t.lastDay}`);
      out('');
      out(`  processed tokens   ${human(t.processed)}`);
      out(`  requests           ${t.requests.toLocaleString()}`);
      out(`  sessions           ${t.sessions.toLocaleString()}`);
      out(`  cache hit rate     ${hit === null ? 'n/a' : (hit * 100).toFixed(1) + '%'}`);
      out(`  mean context       ${human(t.meanContext)}`);
      out(`  peak context       ${human(t.peakContext)}`);
      out('');
      out(`  input              ${human(t.input)}`);
      out(`  cache write        ${human(t.cacheWrite)}`);
      out(`  cache read         ${human(t.cacheRead)}`);
      out(`  output             ${human(t.output)}   (thinking ${human(t.thinking)})`);

      out('');
      out('  by origin');
      for (const o of byOrigin(db, project)) {
        out(`    ${o.origin.padEnd(10)} ${String(o.requests).padStart(7)} req  ${human(o.processed).padStart(9)}`);
      }
      out('');
      out('  by slot');
      for (const s of bySlot(db, project)) {
        out(`    ${s.slot.padEnd(10)} ${String(s.requests).padStart(7)} req  ${human(s.processed).padStart(9)}`);
      }
      out('');
      out('  by model');
      for (const m of byModel(db, project)) {
        out(`    ${(m.model ?? '(none)').padEnd(28)} ${String(m.requests).padStart(7)} req  ${human(m.processed).padStart(9)}`);
      }
      out('');
      return 0;
    }

    case 'rates': {
      const project = registerProject(db, { rootPath: projectPath });
      const solved = solveRates(db, project);

      out('');
      out('Rates recovered from Claude Code billing            $ per million tokens');
      out('model                        sess   input   output   cw 5m   cw 1h    read   med err');
      for (const s of solved) {
        if (!s.rates) {
          out(`  ${s.model.padEnd(26)} ${String(s.sessions).padStart(4)}   -- ${s.note ?? ''}`);
          continue;
        }
        const f = (n: number) => n.toFixed(2).padStart(7);
        const mark = s.corroborated ? ' ' : '!';
        out(
          `${mark} ${s.model.padEnd(26)} ${String(s.sessions).padStart(4)}` +
            `${f(s.rates.inputPerMTok)}${f(s.rates.outputPerMTok)}${f(s.rates.cacheWrite5mPerMTok)}` +
            `${f(s.rates.cacheWrite1hPerMTok)}${f(s.rates.cacheReadPerMTok)}  ` +
            `${(s.medianRelError * 100).toFixed(1)}%${s.corroborated ? '' : '   ' + s.note}`,
        );
      }
      out('');
      out('The input rate is derived as 10x the fitted cache-read rate, not fitted:');
      out('input tokens are too few to carry signal. A row is only written when the');
      out('fitted cache-write rate independently agrees with the observed tier mix.');

      if (values.write) {
        const validFrom = values.from ?? '2026-08-01T00:00:00Z';
        const w = writeCards(db, solved, validFrom);
        const aliases = seedAliases(db, project);
        out('');
        out(`Wrote ${w.written} card(s) effective ${validFrom}.`);
        for (const s of w.skipped) out(`  not written  ${s}`);
        for (const a of aliases) out(`  alias        ${a.alias} -> ${a.to}`);
      }

      const cards = listCards(db);
      if (cards.length > 0) {
        const cost = costSummary(db, project);
        const rec = reconcile(db, project);
        out('');
        out(`API-equivalent cost   $${cost.totalUSD.toFixed(2)}   (${cost.costedRequests.toLocaleString()} requests priced)`);
        if (cost.uncostedRequests > 0) {
          out(`Uncosted              ${cost.uncostedRequests.toLocaleString()} requests with no card:`);
          for (const u of cost.uncostedModels) out(`    ${u.model ?? '(none)'}  ${u.requests}`);
        }
        out('');
        if (rec.sessions === 0) {
          out('Reconciliation        not possible: these transcripts carry no cost-state records,');
          out('                      so there is no billing to check the rates against. Cost above');
          out('                      is computed from cards solved on another project.');
        } else {
          out(
            `Reconciliation        computed $${rec.computedUSD.toFixed(2)} vs billed $${rec.billedUSD.toFixed(2)} ` +
              `over ${rec.sessions} sessions`,
          );
          out(
            `                      median session error ${(rec.medianRelError * 100).toFixed(1)}%, ` +
              `total ${((rec.computedUSD - rec.billedUSD) / rec.billedUSD * 100).toFixed(1)}%`,
          );
          out('Billing counts usage the transcripts never recorded, so these cannot match');
          out('exactly. The shape of the difference is the signal, not its absence.');
        }
      } else {
        out('');
        out('No rate cards stored. Re-run with --write to persist the rows above.');
      }
      out('');
      return 0;
    }

    case 'tasks': {
      const project = registerProject(db, { rootPath: projectPath });
      const tasks = reconstructTasks(db, project);
      if (tasks.length === 0) {
        out('No tasks reconstructed. Run `tokenviz ingest` first.');
        return 1;
      }
      const metrics = taskMetrics(db, project, tasks);
      const s = summariseTasks(db, project, metrics);
      const usd = (n: number | null) => (n === null ? 'n/a' : '$' + n.toFixed(2));
      const pct = (n: number | null) => (n === null ? 'n/a' : (n * 100).toFixed(1) + '%');
      const dur = (ms: number | null) =>
        ms === null ? 'n/a' : ms >= 3600000 ? (ms / 3600000).toFixed(1) + 'h' : (ms / 60000).toFixed(0) + 'm';

      out('');
      out(`${s.tasks} tasks  ·  ${s.landed} landed / ${s.abandoned} abandoned / ${s.open} open`);
      out('');
      out(`  land rate               ${pct(s.landRate)}`);
      out(`  autonomous success      ${pct(s.autonomousSuccessRate)}   (landed with no human takeover)`);
      out(`  tasks with a takeover   ${s.withTakeover}`);
      out('');
      out(`  cost per landed task    ${usd(s.costPerLanded)}`);
      out(`  cost per autonomous     ${usd(s.costPerAutonomousSuccess)}`);
      out(`  attributed spend        ${usd(s.totalUSD)}`);
      out(`  orchestration overhead  ${usd(s.noTaskSlotUSD)}  ${s.noTaskSlotRequests.toLocaleString()} requests in CEO and owner slots, which open no PRs`);
      out(`  between tasks           ${usd(s.betweenTasksUSD)}  in coder slots but cut off from any task by the 6h silence timeout`);
      out('');
      out(`  p50 / p95 cost          ${usd(s.p50CostUSD)} / ${usd(s.p95CostUSD)}`);
      out(`  p50 / p95 duration      ${dur(s.p50DurationMs)} / ${dur(s.p95DurationMs)}`);

      out('');
      out('  by role');
      const roles = new Map<string, { n: number; landed: number; usd: number; takeover: number }>();
      for (const m of metrics) {
        const r = roles.get(m.role) ?? { n: 0, landed: 0, usd: 0, takeover: 0 };
        r.n += 1;
        if (m.outcome === 'landed') r.landed += 1;
        r.usd += m.costUSD;
        if (m.takeover) r.takeover += 1;
        roles.set(m.role, r);
      }
      for (const [role, r] of [...roles].sort((a, b) => b[1].usd - a[1].usd)) {
        out(
          `    ${role.padEnd(12)} ${String(r.n).padStart(4)} tasks  ${String(r.landed).padStart(4)} landed  ` +
            `${usd(r.usd).padStart(10)}  ${usd(r.usd / Math.max(r.landed, 1)).padStart(8)}/landed  ` +
            `${r.takeover} takeovers`,
        );
      }

      const worstN = Number(values.worst ?? 5);
      const worst = [...metrics].sort((a, b) => b.costUSD - a.costUSD).slice(0, worstN);
      out('');
      out(`  most expensive tasks`);
      for (const m of worst) {
        out(
          `    #${String(m.prNumber).padEnd(5)} ${m.slot.padEnd(10)} ${usd(m.costUSD).padStart(9)}  ` +
            `${String(m.requests).padStart(5)} req  ${dur(m.durationMs).padStart(6)}  ` +
            `${m.takeover ? 'takeover' : '        '}  ${(m.title ?? m.taskSlug).slice(0, 44)}`,
        );
      }
      out('');
      return 0;
    }

    case 'watch': {
      const project = registerProject(db, { rootPath: projectPath });
      const seconds = Math.max(1, Number(values.interval ?? 5));
      const file = ledgerPath(project);

      out('');
      out(`Watching ${file}`);
      out(`every ${seconds}s. Ctrl-C to stop.`);
      out('');
      if (!fs.existsSync(file)) {
        out('The ledger does not exist yet. Watching anyway; it will be picked up when it appears.');
      }
      const before = ledgerStats(db, project);
      out(`Already captured: ${before.revisions} revision(s), ${before.tasks} task(s).`);
      out('');

      let lastMtime = -1;
      const tick = () => {
        let mtime = -1;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          return;
        }
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        const res = captureLedger(db, project);
        if (res.status === 'captured') {
          out(
            `${new Date().toISOString().slice(11, 19)}  rev ${res.rev}  ` +
              `batch ${res.batchId ?? '-'}  ${res.tasks} task(s)`,
          );
          for (const a of checkAlerts(db, project)) out(`  ! ${a.message}`);
        }
      };

      tick();
      const timer = setInterval(tick, seconds * 1000);
      const stop = () => {
        clearInterval(timer);
        const after = ledgerStats(db, project);
        out('');
        out(
          `Stopped. ${after.revisions} revision(s), ${after.tasks} task(s), ` +
            `${after.repaired} needed repair, ${after.withPr} carry a PR number.`,
        );
        db.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return 0;
    }

    case 'serve': {
      const port = Number(values.port ?? 7333);
      serve(db, { port });
      out('');
      out(`  TokenViz  http://127.0.0.1:${port}`);
      out('');
      out('  Loopback only. The store spans every project on this machine,');
      out('  including private ones, so it is never exposed by default.');
      out('');
      out('  Ctrl-C to stop.');
      return 0;
    }

    case 'promotions': {
      const project = registerProject(db, {
        rootPath: projectPath,
        githubRepo: repoSlug(projectPath),
      });
      const promotions = listPromotions(db, project);
      const s = summarise(promotions);

      if (s.total === 0) {
        out(
          `No promotions found. Expected merges of "${DEFAULT_COMMANDER_CONFIG.integrationBranch}" ` +
            'into the default branch. Run `tokenviz ingest` first.',
        );
        return 1;
      }

      const rate = s.attemptSuccessRate === null ? 'n/a' : `${(s.attemptSuccessRate * 100).toFixed(1)}%`;
      out('');
      out(`${s.total} promotions  ·  ${s.succeeded} success / ${s.failed} failure  ·  attempt-level ${rate}`);
      if (s.unmatched > 0) out(`${s.unmatched} with no matching deploy run`);

      if (s.failures.length > 0) {
        out('');
        out('Failed promotions');
        for (const f of s.failures) {
          out(`  ${f.committedAt.slice(0, 10)}  PR #${f.prNumber}  ${f.conclusion}  run ${f.runId}`);
          if (values.steps && f.runId !== null) {
            for (const step of failedSteps(project, f.runId)) out(`      ${step}`);
          }
        }
        out('');
        out('Outcome-level: every promotion above was followed by a later successful one,');
        out('so these are deploy rework, not permanently stuck releases.');
      }
      out('');
      return 0;
    }

    case 'projects': {
      for (const p of listProjects(db)) {
        out(`${p.slug.padEnd(16)} ${p.github_repo ?? '-'}  ${p.root_path}`);
      }
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
