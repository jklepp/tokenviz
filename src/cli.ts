#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDb, storePath } from './store/db.ts';
import { listProjects, registerProject } from './store/projects.ts';
import { repoSlug } from './sources/gh.ts';
import { ingestActions } from './ingest/actions.ts';
import { ingestGitHistory } from './ingest/gitHistory.ts';
import { ingestTranscripts } from './ingest/transcripts.ts';
import { byModel, byOrigin, bySlot, cacheHitRate, human, totals } from './report/usage.ts';
import {
  DEFAULT_COMMANDER_CONFIG,
  failedSteps,
  listPromotions,
  summarise,
} from './adapters/commander/promotions.ts';

const USAGE = `tokenviz — FinOps metrics for agentic development

  tokenviz ingest      [--project <path>] [--adapter <name>]
  tokenviz usage       [--project <path>]
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
      } else {
        out('actions  skipped (no GitHub remote)');
      }

      const t = ingestTranscripts(db, project);
      out(
        `scripts  ${t.filesSeen} transcripts: ${t.filesUnchanged} unchanged, ` +
          `${t.filesResumed} resumed, ${t.filesRescanned} rescanned` +
          (t.filesFailed > 0 ? `, ${t.filesFailed} failed` : ''),
      );
      out(
        `         ${t.linesRead.toLocaleString()} lines read, ` +
          `${t.requestsInserted.toLocaleString()} new requests, ` +
          `${t.costStates} cost-state records`,
      );
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
