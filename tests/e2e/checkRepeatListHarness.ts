// `--check-repeat-list` on the installed runtime (`installedRuntime.ts`), with the command's outcomes reduced to
// the facts its contract fixes by the same reducers `--validate-flow`'s specs use.

import { useInstalledRuntime, type InstalledRuntime } from './installedRuntime';
import type { RunResult } from '../helpers/validateOutcome';

export { passOutcome, problemOutcome, runText, type RunResult } from '../helpers/validateOutcome';
export { PASSED, USAGE, problemLine, usageOutcome } from './validateFlowHarness';

/** The flag as a user types it: the command's contract, not an app constant. */
export const CHECK_REPEAT_LIST_FLAG = '--check-repeat-list';

export interface CheckRepeatListRuntime extends InstalledRuntime {
  /** Runs the checker runtime with `--check-repeat-list` then `operands`, each a verbatim argv element. */
  check(operands: readonly string[], options: { cwd: string }): Promise<RunResult>;
}

/** Call once at the top of a spec: `useInstalledRuntime()` with the `--check-repeat-list` runs on top. */
export function useCheckRepeatListRuntime(): CheckRepeatListRuntime {
  const runtime = useInstalledRuntime();
  return { ...runtime, check: (operands, options) => runtime.runRaw([CHECK_REPEAT_LIST_FLAG, ...operands], options) };
}
