// CI — run, don't block (§26.7 / D54 / L8). The impl loop NEVER waits on CI: the PR goes non-draft at
// plan-approval (the L5 `gh pr ready`) and thereafter impl commits trigger checks asynchronously. At
// review time the app takes a BEST-EFFORT, NON-BLOCKING snapshot of whatever CI state already exists and
// records it display-only — the external engine's polling `ci-waiter` actor is removed. `gh pr checks` is
// Claude Code's own tool surface (its private `bucket` categorization); the parser degrades to null
// (omit) on any drift, and the port never blocks the loop's advance.

import { execFile } from 'node:child_process';

/** A best-effort snapshot of the PR's checks at review time (§26.7). Display-only — never gates the loop. */
export interface CiSnapshot {
  total: number;
  passed: number;
  failed: number;
  pending: number;
}

/** The CI-state read a review-time snapshot needs, in the app's own vocabulary (not the gh CLI's).
 *  `snapshot` is best-effort: null when there is no PR, gh fails, or the PR has no checks (§26.7 "omitted
 *  if none"). It must NOT block on pending checks — it reads the current state and returns. */
export interface CiChecks {
  snapshot(pr: number): Promise<CiSnapshot | null>;
}

/** Parse `gh pr checks --json bucket` output into the counts (§26.7). Null (omit) when the output is not
 *  a non-empty JSON array — an empty check set is "no CI to report", not a zero snapshot. */
export function parseCiChecks(raw: string): CiSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const c of parsed) {
    const bucket = c && typeof c === 'object' ? (c as { bucket?: unknown }).bucket : undefined;
    if (bucket === 'pass') passed += 1;
    else if (bucket === 'fail') failed += 1;
    else if (bucket === 'pending') pending += 1;
  }
  return { total: parsed.length, passed, failed, pending };
}

const EXEC_TIMEOUT_MS = 60_000;

/** The real port: `gh pr checks <pr> --json bucket`. gh exits non-zero when checks are pending/failing,
 *  but still writes the JSON to stdout — so parse stdout regardless of the exit code, and NEVER wait
 *  (`gh pr checks` without `--watch` returns the current state immediately). */
export function createRealCiChecks(repoDir: string): CiChecks {
  return {
    snapshot: (pr) =>
      new Promise((resolve) => {
        execFile('gh', ['pr', 'checks', String(pr), '--json', 'bucket'], { cwd: repoDir, timeout: EXEC_TIMEOUT_MS }, (_err, stdout) => {
          resolve(parseCiChecks(stdout ?? ''));
        });
      }),
  };
}
