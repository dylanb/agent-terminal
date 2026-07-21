// The §27 approve side-effect port (§27.13 / N5) — a SIBLING of the §26 `gateGithub` port; no §26 concept
// crosses the seam (§27.15). Depends on a domain `gh` runner, never raw exec(argv) (CODE-STANDARDS seam
// rule); the real runner uses execFile so every value crosses as a distinct argv element (CWE-78).

import { execFile } from 'node:child_process';

/** The refs + confined body-file an approve side-effect acts on. Any may be absent; an action whose required
 *  input is absent fails best-effort (throws) rather than fabricating a target. */
export interface AppGateSideEffectCtx {
  pr: number | null;
  ticket: number | null;
  bodyFile: string | null;
}

/** Run one declared approve `gh` action for the ctx it acts on. Throws on an unknown action or a missing
 *  required input; the caller treats the throw as a best-effort failure (surfaced + audited, §27.13 / AC3). */
export type RunAppGateSideEffect = (action: string, ctx: AppGateSideEffectCtx) => Promise<void>;

/** The domain runner the port depends on: run a `gh` invocation as a structured argv (CWE-78). Injected so a
 *  test asserts the argv mapping without shelling a real `gh`; the real one is `createRealAppGateGitHub`. */
export type GhRunner = (argv: string[]) => Promise<void>;

const EXEC_TIMEOUT_MS = 60_000;

/** Map a §27 approve `gh` action + ctx to its structured `gh` argv (§27.13). An action whose required input
 *  is absent throws so the caller records a best-effort failure rather than issuing a malformed call. */
export function createAppGateGitHub(runGh: GhRunner): RunAppGateSideEffect {
  return async (action, ctx) => {
    switch (action) {
      case 'mark-ready':
        if (ctx.pr === null) throw new Error('no PR to mark ready');
        await runGh(['pr', 'ready', String(ctx.pr)]);
        return;
      case 'update-issue-body':
        if (ctx.ticket === null) throw new Error('no issue to publish the body to');
        if (ctx.bodyFile === null) throw new Error('no body artifact to publish');
        await runGh(['issue', 'edit', String(ctx.ticket), '--body-file', ctx.bodyFile]);
        return;
      case 'publish-pr-body':
        if (ctx.pr === null) throw new Error('no PR to publish the body to');
        if (ctx.bodyFile === null) throw new Error('no body artifact to publish');
        await runGh(['pr', 'edit', String(ctx.pr), '--body-file', ctx.bodyFile]);
        return;
      default:
        throw new Error(`unknown approve side-effect action: ${action}`);
    }
  };
}

/** The production port: shells `gh` via execFile (CWE-78 — every value a distinct argv element, never a shell
 *  string), scoped to the repo working tree. */
export function createRealAppGateGitHub(repoDir: string): RunAppGateSideEffect {
  return createAppGateGitHub(
    (argv) =>
      new Promise<void>((resolve, reject) => {
        execFile('gh', argv, { cwd: repoDir, timeout: EXEC_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
      }),
  );
}
