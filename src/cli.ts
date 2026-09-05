#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDb, storePath } from './store/db.ts';
import { listProjects, registerProject } from './store/projects.ts';
import { repoSlug } from './sources/gh.ts';
import { ingestActions } from './ingest/actions.ts';
import { ingestGitHistory } from './ingest/gitHistory.ts';
import { DEFAULT_COMMANDER_CONFIG, failedSteps, listPromotions, summarise } from './adapters/commander/promotions.ts';

const USAGE = `tokenviz — FinOps metrics for agentic development

  tokenviz ingest      [--project <path>] [--adapter <name>]
  tokenviz promotions  [--project <path>] [--steps]
  tokenviz projects

Store: ${storePath()}  (override with TOKENVIZ_HOME)
`;

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
      process.stdout.write(`project  ${project.slug}  (${project.github_repo ?? 'no GitHub remote'})\n`);

      const git = ingestGitHistory(db, project);
      process.stdout.write(
        `git      ${git.seen} first-parent commits on ${git.branch}, ${git.inserted} new\n`,
      );

      if (project.github_repo) {
        const actions = ingestActions(db, project);
        process.stdout.write(`actions  ${actions.seen} runs seen, ${actions.inserted} new\n`);
      } else {
        process.stdout.write('actions  skipped (no GitHub remote)\n');
      }
      return 0;
    }

    case 'promotions': {
      const project = registerProject(db, { rootPath: projectPath, githubRepo: repoSlug(projectPath) });
      const promotions = listPromotions(db, project);
      const s = summarise(promotions);

      if (s.total === 0) {
        process.stdout.write(
          `No promotions found. Expected merges of "${DEFAULT_COMMANDER_CONFIG.integrationBranch}" ` +
            `into the default branch. Run \`tokenviz ingest\` first.\n`,
        );
        return 1;
      }

      const rate = s.attemptSuccessRate === null ? 'n/a' : `${(s.attemptSuccessRate * 100).toFixed(1)}%`;
      process.stdout.write(
        `\n${s.total} promotions  ·  ${s.succeeded} success / ${s.failed} failure  ·  ` +
          `attempt-level ${rate}\n`,
      );
      if (s.unmatched > 0) {
        process.stdout.write(`${s.unmatched} with no matching deploy run\n`);
      }

      if (s.failures.length > 0) {
        process.stdout.write(`\nFailed promotions\n`);
        for (const f of s.failures) {
          process.stdout.write(
            `  ${f.committedAt.slice(0, 10)}  PR #${f.prNumber}  ${f.conclusion}  run ${f.runId}\n`,
          );
          if (values.steps && f.runId !== null) {
            for (const step of failedSteps(project, f.runId)) {
              process.stdout.write(`      ${step}\n`);
            }
          }
        }
        process.stdout.write(
          `\nOutcome-level: every promotion above was followed by a later successful one,\n` +
            `so these are deploy rework, not permanently stuck releases.\n`,
        );
      }
      process.stdout.write('\n');
      return 0;
    }

    case 'projects': {
      for (const p of listProjects(db)) {
        process.stdout.write(`${p.slug.padEnd(16)} ${p.github_repo ?? '-'}  ${p.root_path}\n`);
      }
      return 0;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
