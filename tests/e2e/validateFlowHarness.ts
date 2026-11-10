// `--validate-flow` on the installed runtime (`installedRuntime.ts`), and the command's outcomes reduced to the
// facts its contract fixes.

import { expect } from '@playwright/test';
import { readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { runText, type RunResult } from '../helpers/validateOutcome';
import { REPO_ROOT, useInstalledRuntime, type InstalledRuntime } from './installedRuntime';

export { passOutcome, problemOutcome, runText, type RunResult } from '../helpers/validateOutcome';

/** The flag as a user types it: the command's contract, not an app constant. */
export const VALIDATE_FLOW_FLAG = '--validate-flow';

export interface ValidateRuntime extends InstalledRuntime {
  /** Runs the checker runtime with `--validate-flow` then `operands`, each a verbatim argv element. */
  validate(operands: readonly string[], options: { cwd: string }): Promise<RunResult>;
  /** Runs `--validate-flow` then `operands` from `cwd`, which is removed after the run enters it and before the
   *  runtime starts, so the runtime inherits a working directory that no longer exists. */
  validateFromRemovedCwd(operands: readonly string[], options: { cwd: string }): Promise<RunResult>;
}

/** Call once at the top of a spec: `useInstalledRuntime()` with the `--validate-flow` runs on top. */
export function useValidateRuntime(): ValidateRuntime {
  const runtime = useInstalledRuntime();
  return {
    ...runtime,
    validate: (operands, options) => runtime.runRaw([VALIDATE_FLOW_FLAG, ...operands], options),
    validateFromRemovedCwd: (operands, { cwd }) =>
      runtime.runOwned('/bin/sh', ['-c', 'cd "$1" && rmdir "$1" && shift && exec "$@"', 'sh', cwd, ...runtime.runtimeCommand(), VALIDATE_FLOW_FLAG, ...operands], {
        cwd: runtime.world().root,
      }),
  };
}

/** Every flow folder the built bundle under `runtimeMain` ships, then every `example/flows/<id>/` of this source
 *  tree, enumerated so a new bundled flow is covered without a test change. */
export function bundledFlowFolders(runtimeMain: string): string[] {
  const entries = (flowsDir: string): string[] => {
    const dirs = readdirSync(flowsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(flowsDir, e.name)).sort();
    if (dirs.length === 0) throw new Error(`bundledFlowFolders(): no flow folder under ${flowsDir}`);
    return dirs;
  };
  return [
    ...entries(resolveExampleFlowsDir({ packaged: false, appPath: runtimeMain })),
    ...entries(resolveExampleFlowsDir({ packaged: false, appPath: REPO_ROOT })),
  ];
}

export const PASSED = { status: 0, oneLine: true, okLine: true, output: expect.any(String) };

/** The expected `problemOutcome`: exit 1, one prefixed line, and a problem text that `problem` matches. */
export function problemLine(problem: unknown = expect.any(String)): { status: 1; oneLine: true; prefixed: true; problem: unknown; output: unknown } {
  return { status: 1, oneLine: true, prefixed: true, problem, output: expect.any(String) };
}

/** A usage error, reduced to the CLI contract's facts. */
export function usageOutcome(result: RunResult): { status: number | null; stdout: string; stderrWritten: boolean; output: string } {
  return { status: result.status, stdout: result.stdout, stderrWritten: result.stderr.trim() !== '', output: runText(result) };
}

export const USAGE = { status: 2, stdout: '', stderrWritten: true, output: expect.any(String) };

/** The two absolute spellings a refusal of folder `operand` may print: resolved lexically against `cwd`, or
 *  with its parent's links resolved and its own name kept. */
export function folderPrefixes(cwd: string, operand: string): string[] {
  const lexical = resolve(cwd, operand);
  try {
    return [...new Set([lexical, join(realpathSync(dirname(lexical)), basename(lexical))])];
  } catch {
    return [lexical];
  }
}

/** The errno code and its description (`ENOENT: no such file or directory`) of the error `provoke` throws,
 *  without the system-call name or path, for an oracle the test provokes itself. */
export function errnoDescription(provoke: () => unknown): string {
  try {
    provoke();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return message.split(', ')[0];
  }
  throw new Error('errnoDescription(): the call did not fail');
}
