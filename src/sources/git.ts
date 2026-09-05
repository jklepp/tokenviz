import { execFileSync } from 'node:child_process';

const SEP = '\u001f';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
}

export type MainCommit = {
  sha: string;
  committedAt: string;
  subject: string;
  parentCount: number;
};

/**
 * First-parent history of a branch, newest first. First-parent is what makes
 * merge commits legible: it walks the trunk without descending into the
 * branches that were merged into it.
 */
export function firstParentHistory(cwd: string, branch = 'main'): MainCommit[] {
  const out = git(cwd, [
    'log',
    '--first-parent',
    branch,
    `--format=%H${SEP}%cI${SEP}%P${SEP}%s`,
  ]);
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [sha, committedAt, parents, ...rest] = line.split(SEP);
      return {
        sha: sha!,
        committedAt: committedAt!,
        subject: rest.join(SEP),
        parentCount: parents!.trim() === '' ? 0 : parents!.trim().split(/\s+/).length,
      };
    });
}

export function defaultBranch(cwd: string): string {
  for (const candidate of ['main', 'master']) {
    try {
      git(cwd, ['rev-parse', '--verify', candidate]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(`no main or master branch in ${cwd}`);
}
