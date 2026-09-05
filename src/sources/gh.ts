import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const FALLBACKS = [
  'C:\Program Files\GitHub CLI\gh.exe',
  'C:\Program Files (x86)\GitHub CLI\gh.exe',
  '/usr/bin/gh',
  '/usr/local/bin/gh',
];

let cached: string | null = null;

export function ghBin(): string {
  if (cached) return cached;
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' });
    cached = 'gh';
    return cached;
  } catch {
    // not on PATH; fall through
  }
  const found = FALLBACKS.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      'GitHub CLI not found. Install it, or put `gh` on PATH. TokenViz needs it for Actions history.',
    );
  }
  cached = found;
  return cached;
}

function run(args: string[]): string {
  return execFileSync(ghBin(), args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
}

/**
 * Page through a REST endpoint, projecting each item with a jq filter that
 * yields one JSON value per line.
 *
 * `gh run list` caps at 400 runs; the raw API paginates all the way back to
 * repository inception, which is why ingest goes through `gh api` instead.
 */
export function apiPaginate<T>(endpoint: string, jq: string): T[] {
  const out = run(['api', '--paginate', endpoint, '--jq', jq]);
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

export function api<T>(endpoint: string): T {
  return JSON.parse(run(['api', endpoint])) as T;
}

/** `owner/name` for a local clone, or null when it has no GitHub remote. */
export function repoSlug(cwd: string): string | null {
  try {
    return execFileSync(ghBin(), ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}
