// agent-terminal CLI shim installer (§23.4 / #25): writes the launch shim and ensures it is on PATH
// for new shells, idempotently reconciling to the running build.

import type { CliInstallResult } from '../shared/ipc';
import type { LaunchInvocation } from './cliShim';

/** Where the install lands, injected as a domain seam so tests install into a temp PATH/profile
 *  (CLAUDE.md "narrow domain seam"): the shim's bin directory, the shell-profile files to extend
 *  PATH in, and the current PATH used to decide whether the bin directory is already reachable. */
export interface InstallTarget {
  binDir: string;
  profiles: string[];
  currentPath: string;
  invocation: LaunchInvocation;
}

export function installCliShim(_target: InstallTarget): CliInstallResult {
  return { ok: false, error: 'not implemented' };
}
