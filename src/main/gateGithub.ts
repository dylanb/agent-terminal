// Out-of-band GitHub side-effects for gate transitions (§26.6 / D53). Like pickup (§26.9) these run as
// app `gh` calls, NOT terminal injection — so a busy shell can't block them and each is best-effort. The
// orchestrator depends on the DOMAIN port (markPrReady), never raw exec(argv) — the CLAUDE.md seam rule;
// the real port shells out via execFile (CWE-78: every value crosses as a distinct argv element).

import { execFile } from 'node:child_process';

/** The GitHub operations a gate transition performs. `markPrReady` flips the draft PR non-draft at
 *  plan-approval (§26.7 — thereafter impl commits trigger CI async; the loop never waits). `createSubIssue`
 *  opens one epic sub-ticket (§26.9 / L8), returning its issue number or null when the create failed. */
export interface GateGitHub {
  markPrReady(pr: number): Promise<void>;
  createSubIssue(args: { title: string; body: string }): Promise<number | null>;
}

const EXEC_TIMEOUT_MS = 60_000;

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** A `gh issue create` URL ends in `/<number>`; pull it, or null when unparseable. */
function issueNumberFromUrl(url: string): number | null {
  const m = url.trim().match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function createRealGateGitHub(repoDir: string): GateGitHub {
  return {
    markPrReady: async (pr) => void (await run('gh', ['pr', 'ready', String(pr)], repoDir)),
    // CWE-78: title/body cross as distinct argv elements, never spliced into a shell string.
    createSubIssue: async ({ title, body }) => {
      try {
        return issueNumberFromUrl(await run('gh', ['issue', 'create', '--title', title, '--body', body], repoDir));
      } catch {
        return null;
      }
    },
  };
}
