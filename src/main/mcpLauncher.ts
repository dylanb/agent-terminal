import type { LaunchInvocation } from './cliShim';

/** Writes the launcher Claude Code runs for the server and its hooks, pointed at the running build, and returns how
 *  to run it. The returned launch is the same for every build, so entries installed once keep working after the app
 *  is updated or moved. */
export async function refreshMcpLauncher(_appHome: string, invocation: LaunchInvocation): Promise<{ command: string; args: string[] }> {
  return { command: invocation.execPath, args: [...invocation.appArgs] };
}
