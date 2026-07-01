// Out-of-band GitHub side-effects for gate transitions (§26.6 / D53). Like pickup (§26.9) these run as
// app `gh` calls, NOT terminal injection — so a busy shell can't block them and each is best-effort. The
// orchestrator depends on the DOMAIN port (markPrReady), never raw exec(argv) — the CLAUDE.md seam rule;
// the real port shells out via execFile (CWE-78: every value crosses as a distinct argv element).

import { execFile } from 'node:child_process';

/** The GitHub operations a gate transition performs. `markPrReady` flips the draft PR non-draft at
 *  plan-approval (§26.7 — thereafter impl commits trigger CI async; the loop never waits). */
export interface GateGitHub {
  markPrReady(pr: number): Promise<void>;
}

const EXEC_TIMEOUT_MS = 60_000;

function run(file: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
  });
}

export function createRealGateGitHub(repoDir: string): GateGitHub {
  return {
    markPrReady: (pr) => run('gh', ['pr', 'ready', String(pr)], repoDir),
  };
}
