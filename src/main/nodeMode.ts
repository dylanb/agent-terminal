import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';

/** How to run a script the build emits beside the main bundle in plain-Node mode: the app binary and that script. */
export interface NodeModeRuntime {
  execPath: string;
  script: string;
}

/** The script a build entry is emitted as, beside the main bundle in `mainDir`. */
export function bundledScript(mainDir: string, entry: string): string {
  return path.join(mainDir, `${entry}.js`);
}

/** The environment assignment that puts the app binary in plain-Node mode. */
export const NODE_MODE_ASSIGNMENT = 'ELECTRON_RUN_AS_NODE=1';

/** The shell command that runs the app binary at `execPath` in plain-Node mode with `argv` (its script first), every
 *  operand quoted (CWE-78). */
export function nodeModeCommand(execPath: string, argv: readonly string[]): string {
  return [NODE_MODE_ASSIGNMENT, ...[execPath, ...argv].map(shellQuote)].join(' ');
}
