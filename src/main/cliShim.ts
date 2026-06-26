// agent-terminal launch shim generation (§23.4 / #25).

/** The launch invocation a generated shim execs to start a fresh, independent instance: the app
 *  binary plus the args needed to load this build (none when packaged, the main script in dev). */
export interface LaunchInvocation {
  execPath: string;
  appArgs: string[];
}

/** The installed command's filename. */
export const CLI_COMMAND_NAME = 'agent-terminal';

export function generateShim(_invocation: LaunchInvocation): string {
  return '';
}
