import path, { join } from 'node:path';
import { MCP_HOOK_ARG, MCP_LAUNCHER_NAME, MCP_WINDOW_ENV, MCP_WINDOW_EXEC_ENV, MCP_WINDOW_SCRIPT_ENV } from '../shared/mcp';
import { shellQuote } from '../shared/shellQuote';
import { atomicWriteFileSync } from './atomicFile';
import { bundledScript, NODE_MODE_ASSIGNMENT, nodeModeCommand } from './nodeMode';
import type { LaunchInvocation } from './cliShim';

/** The rollup entry name the build emits the server and hook runtime under, beside the main bundle. */
export const MCP_ENTRY = 'mcp';

export function resolveMcpScript(mainDir: string): string {
  return bundledScript(mainDir, MCP_ENTRY);
}

/** How the integration's entries run the server and its hooks. */
export interface McpLaunch {
  command: string;
  args: string[];
}

/** How the installed entries run the server and its hooks under `appHome`: the same for every build, so entries
 *  installed once keep working after the app is updated or moved. */
export function mcpLaunch(appHome: string): McpLaunch {
  return { command: join(appHome, '.agent-terminal', 'claude-code', MCP_LAUNCHER_NAME), args: [] };
}

/** Writes the launcher Claude Code runs for the server and its hooks, pointed at the running build, and returns how
 *  to run it. A session in a window runs that window's own build instead. */
export async function refreshMcpLauncher(appHome: string, invocation: LaunchInvocation): Promise<McpLaunch> {
  const launch = mcpLaunch(appHome);
  const ownBuild = `"$${MCP_WINDOW_EXEC_ENV}"`;
  const script = [
    '#!/bin/sh',
    // Every Claude Code session on the machine runs the hooks; outside a window they have nothing to do, so they
    // answer here rather than start the app.
    `if [ "\${1:-}" = ${shellQuote(MCP_HOOK_ARG)} ] && [ -z "\${${MCP_WINDOW_ENV}:-}" ]; then`,
    '  cat >/dev/null',
    '  exit 0',
    'fi',
    `if [ -n "\${${MCP_WINDOW_EXEC_ENV}:-}" ] && [ -x ${ownBuild} ]; then`,
    `  exec env ${NODE_MODE_ASSIGNMENT} ${ownBuild} "$${MCP_WINDOW_SCRIPT_ENV}" "$@"`,
    'fi',
    // Every Claude Code session on the machine runs the hooks, so a build that has gone away must make them a no-op.
    `[ -x ${shellQuote(invocation.execPath)} ] || exit 0`,
    `exec env ${nodeModeCommand(invocation.execPath, invocation.appArgs)} "$@"`,
    '',
  ].join('\n');
  if (!atomicWriteFileSync(launch.command, script, { mode: 0o755 })) {
    throw new Error(`${path.dirname(launch.command)} is a symbolic link, so the launcher was not written`);
  }
  return launch;
}
