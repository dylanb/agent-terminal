import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';

export interface NodeModeRuntime {
  execPath: string;
  script: string;
}

export function bundledScript(mainDir: string, entry: string): string {
  return path.join(mainDir, `${entry}.js`);
}

export const NODE_MODE_ASSIGNMENT = 'ELECTRON_RUN_AS_NODE=1';

export function nodeModeCommand(execPath: string, argv: readonly string[]): string {
  return [NODE_MODE_ASSIGNMENT, ...[execPath, ...argv].map(shellQuote)].join(' ');
}
