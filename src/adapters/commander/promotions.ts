import type { DatabaseSync } from 'node:sqlite';
import type { Project } from '../../store/projects.ts';
import { api } from '../../sources/gh.ts';

/**
 * Commander-specific interpretation. The store below this file knows only about
 * workflow runs and commits; what counts as a *promotion* is a fact about how
 * Commander works, so it lives here rather than in the schema.
 */
export type CommanderConfig = {
  /** Branch merged into the default branch to release. */
  integrationBranch: string;
  /** Workflow whose push-to-main run is the deploy. */
  deployWorkflow: string;
};

export const DEFAULT_COMMANDER_CONFIG: CommanderConfig = {
  integrationBranch: 'integration',
  deployWorkflow: 'Deploy to Cloudflare',
};

export type Promotion = {
  prNumber: number;
  sha: string;
  committedAt: string;
  runId: number | null;
  runAttempt: number | null;
  conclusion: string | null;
  htmlUrl: string | null;
};

/**
 * A promotion is a merge of the integration branch into the default branch.
 *
 * Direct pushes to main are deliberately excluded: Commander made 84 of them on
 * 2026-08-25, before the integration flow existed, and they are not releases.
 * Matching on the merge subject rather than on time is what excludes them.
 */
export function listPromotions(
  db: DatabaseSync,
  project: Project,
  config: CommanderConfig = DEFAULT_COMMANDER_CONFIG,
): Promotion[] {
  const owner = project.github_repo?.split('/')[0] ?? '';
  const pattern = `Merge pull request #% from ${owner}/${config.integrationBranch}`;

  const rows = db
    .prepare(
      `SELECT c.sha, c.committed_at, c.subject,
              r.run_id, r.run_attempt, r.conclusion, r.html_url
         FROM main_commit c
         LEFT JOIN workflow_run r
                ON r.project_id    = c.project_id
               AND r.head_sha      = c.sha
               AND r.workflow_name = ?
               AND r.event         = 'push'
        WHERE c.project_id = ?
          AND c.parent_count > 1
          AND c.subject LIKE ?
        ORDER BY c.committed_at`,
    )
    .all(config.deployWorkflow, project.id, pattern) as unknown as {
    sha: string;
    committed_at: string;
    subject: string;
    run_id: number | null;
    run_attempt: number | null;
    conclusion: string | null;
    html_url: string | null;
  }[];

  return rows.map((r) => ({
    prNumber: Number(/#(\d+)/.exec(r.subject)?.[1] ?? 0),
    sha: r.sha,
    // git records %cI with a local UTC offset; Actions timestamps are UTC.
    // Normalise here so the two are never bucketed into different days.
    committedAt: new Date(r.committed_at).toISOString(),
    runId: r.run_id,
    runAttempt: r.run_attempt,
    conclusion: r.conclusion,
    htmlUrl: r.html_url,
  }));
}

/**
 * Attempt-level and outcome-level success are both reported, deliberately.
 * Attempt-level measures gate friction; outcome-level measures whether anything
 * ever actually got stuck. They answer different questions.
 */
export function summarise(promotions: Promotion[]) {
  const withRun = promotions.filter((p) => p.runId !== null);
  const succeeded = withRun.filter((p) => p.conclusion === 'success');
  const failed = withRun.filter((p) => p.conclusion !== null && p.conclusion !== 'success');
  return {
    total: promotions.length,
    unmatched: promotions.length - withRun.length,
    succeeded: succeeded.length,
    failed: failed.length,
    attemptSuccessRate: withRun.length === 0 ? null : succeeded.length / withRun.length,
    failures: failed,
  };
}

/** The named step that failed, for a run we already know failed. */
export function failedSteps(project: Project, runId: number): string[] {
  type Job = { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] };
  const res = api<{ jobs: Job[] }>(`repos/${project.github_repo}/actions/runs/${runId}/jobs`);
  const out: string[] = [];
  for (const job of res.jobs) {
    for (const step of job.steps ?? []) {
      if (step.conclusion === 'failure') out.push(`${job.name} › ${step.name}`);
    }
  }
  return out;
}
