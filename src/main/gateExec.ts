// §26.6 — the imperative `exec` gate action (ADR 0015 adapter side-effect). Every resolved value crosses
// as a distinct argv element, never spliced into a shell string (CWE-78). Best-effort (§26.11): a failed
// exec is reconciled out of band, never aborts the gate transition. `exec` names the PROGRAM as well as
// its arguments, so whether it may run at all is `loopDef.loopExecAllowed` — an operator-authored def only.

import { execFile } from 'node:child_process';

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Resolvers the run supplies for the two placeholder families an `exec` argv may reference. */
export interface ExecInterpolationContext {
  linkedIssues: number[];
  resolveArtifact(id: string): string | null;
}

/** Resolve one placeholder expression (already trimmed of `{{ }}`), or null when it does not resolve —
 *  an out-of-range issue index, an unknown artifact id, or an unrecognized placeholder family. */
function resolvePlaceholder(expr: string, ctx: ExecInterpolationContext): string | null {
  const issue = /^state\.linked_issues\[(\d+)\]$/.exec(expr);
  if (issue) {
    const n = ctx.linkedIssues[Number(issue[1])];
    return typeof n === 'number' ? String(n) : null;
  }
  const artifact = /^artifact\.(.+)$/.exec(expr);
  if (artifact) return ctx.resolveArtifact(artifact[1]);
  return null;
}

/** Fill every `{{…}}` placeholder in each argv element against `ctx`. Returns the resolved argv, or null
 *  when ANY placeholder does not resolve — so the executor skips rather than run a command with a literal
 *  `{{…}}` or an empty value. An argv with no placeholders passes through unchanged. */
export function interpolateExecArgv(argv: string[], ctx: ExecInterpolationContext): string[] | null {
  const out: string[] = [];
  for (const el of argv) {
    let failed = false;
    const filled = el.replace(PLACEHOLDER, (_m, expr: string) => {
      const v = resolvePlaceholder(expr.trim(), ctx);
      if (v === null) failed = true;
      return v ?? '';
    });
    if (failed) return null;
    out.push(filled);
  }
  return out;
}

/** Run a fully-resolved gate `exec` argv. `argv[0]` is the program, the rest its arguments (execFile,
 *  no shell — CWE-78). Best-effort: resolves on a zero exit, rejects otherwise (the caller swallows,
 *  §26.11). A malformed/empty argv rejects. */
export type RunGateExec = (argv: string[]) => Promise<void>;

const EXEC_TIMEOUT_MS = 60_000;

export function createRealGateExec(repoDir: string): RunGateExec {
  return (argv) =>
    new Promise<void>((resolve, reject) => {
      if (argv.length === 0) {
        reject(new Error('empty exec argv'));
        return;
      }
      execFile(argv[0], argv.slice(1), { cwd: repoDir, timeout: EXEC_TIMEOUT_MS }, (err) =>
        err ? reject(err) : resolve(),
      );
    });
}
