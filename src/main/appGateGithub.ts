// The §27 approve side-effect port (§27.13 / N5) — a SIBLING of the §26 `gateGithub` port; no §26 concept
// crosses the seam (§27.15). Depends on a domain `gh` runner, never raw exec(argv) (CODE-STANDARDS seam
// rule); the real runner uses execFile so every value crosses as a distinct argv element (CWE-78).

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { AppLoopBootstrap } from './appLoopState';
import { isRecord } from './yamlRecord';

/** The refs + confined body-file an approve side-effect acts on. Any may be absent; an action whose required
 *  input is absent fails best-effort (throws) rather than fabricating a target. */
export interface AppGateSideEffectCtx {
  pr: number | null;
  ticket: number | null;
  bodyFile: string | null;
  bootstrap: AppLoopBootstrap | null;
}

/** Run one declared approve `gh` action for the ctx it acts on. Throws on an unknown action or a missing
 *  required input; the caller treats the throw as a best-effort failure (surfaced + audited, §27.13 / AC3). */
export type RunAppGateSideEffect = (action: string, ctx: AppGateSideEffectCtx) => Promise<void>;

/** The domain runner the port depends on: run a `gh` invocation as a structured argv (CWE-78). Injected so a
 *  test asserts the argv mapping without shelling a real `gh`; the real one is `createRealAppGateGitHub`. */
export type GhRunner = (argv: string[], stdin?: string) => Promise<string>;
export type ReadBodyFile = (path: string) => Promise<string>;

const EXEC_TIMEOUT_MS = 60_000;

/** Map a §27 approve `gh` action + ctx to its structured `gh` argv (§27.13). An action whose required input
 *  is absent throws so the caller records a best-effort failure rather than issuing a malformed call. */
export function createAppGateGitHub(
  runGh: GhRunner,
  readBodyFile: ReadBodyFile = (path) => readFile(path, 'utf8'),
): RunAppGateSideEffect {
  const verifyBootstrap = async (ctx: AppGateSideEffectCtx): Promise<void> => {
    const bootstrap = ctx.bootstrap;
    if (bootstrap === null) return;
    if (ctx.pr !== bootstrap.pr || ctx.ticket !== bootstrap.issue) {
      throw new Error('bootstrap PR identity does not match the gate refs');
    }
    let value: unknown;
    try {
      value = JSON.parse(
        await runGh([
          'pr',
          'view',
          String(bootstrap.pr),
          '--json',
          'number,headRefName,state,closingIssuesReferences',
        ]),
      );
    } catch {
      throw new Error('bootstrap PR identity could not be verified');
    }
    if (!isRecord(value)) {
      throw new Error('bootstrap PR identity could not be verified');
    }
    const closesIssue =
      Array.isArray(value.closingIssuesReferences) &&
      value.closingIssuesReferences.some(
        (item) => isRecord(item) && item.number === bootstrap.issue,
      );
    if (
      value.number !== bootstrap.pr ||
      value.headRefName !== bootstrap.branch ||
      value.state !== 'OPEN' ||
      !closesIssue
    ) {
      throw new Error('bootstrap PR identity does not match GitHub');
    }
  };

  return async (action, ctx) => {
    switch (action) {
      case 'mark-ready':
        if (ctx.pr === null) throw new Error('no PR to mark ready');
        await verifyBootstrap(ctx);
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
        await verifyBootstrap(ctx);
        if (ctx.bootstrap !== null) {
          let body: string;
          try {
            body = await readBodyFile(ctx.bodyFile);
          } catch {
            throw new Error('could not read the PR body artifact');
          }
          const artifact = body.trimEnd();
          const closingLine = `closes #${ctx.bootstrap.issue}`;
          await runGh(
            ['pr', 'edit', String(ctx.pr), '--body-file', '-'],
            artifact.length === 0
              ? `${closingLine}\n`
              : `${artifact}\n\n${closingLine}\n`,
          );
          return;
        }
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
  const environment = { ...process.env };
  delete environment.GH_REPO;
  return createAppGateGitHub(
    (argv, stdin) =>
      new Promise<string>((resolve, reject) => {
        const child = execFile(
          'gh',
          argv,
          { cwd: repoDir, timeout: EXEC_TIMEOUT_MS, env: environment },
          (err, stdout) => {
            if (!err) {
              resolve(stdout);
              return;
            }
            const classification =
              typeof err.code === 'number' &&
              Number.isInteger(err.code) &&
              err.code >= 0 &&
              err.code <= 255
                ? `exit ${err.code}`
                : err.killed
                  ? 'timed out'
                  : 'could not start';
            reject(
              new Error(`GitHub command failed (${classification})`),
            );
          },
        );
        if (stdin !== undefined) {
          if (child.stdin === null) {
            child.kill();
            reject(new Error('could not write GitHub CLI input'));
          } else {
            child.stdin.on('error', () =>
              reject(new Error('could not write GitHub CLI input')),
            );
            child.stdin.end(stdin);
          }
        }
      }),
  );
}
