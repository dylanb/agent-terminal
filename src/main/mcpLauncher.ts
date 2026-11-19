import path, { join } from 'node:path';
import { MCP_HOOK_ARG, MCP_LAUNCHER_NAME, MCP_WINDOW_ENV, MCP_WINDOW_EXEC_ENV, MCP_WINDOW_SCRIPT_ENV } from '../shared/mcp';
import { shellQuote } from '../shared/shellQuote';
import { atomicWriteFileSync } from './atomicFile';
import { bundledScript, NODE_MODE_ASSIGNMENT, nodeModeCommand } from './nodeMode';
export interface McpInvocation { execPath: string; appArgs: string[] }

export const MCP_ENTRY = 'mcp';

export function resolveMcpScript(mainDir: string): string {
  return bundledScript(mainDir, MCP_ENTRY);
}

export interface McpLaunch {
  command: string;
  args: string[];
}

export function mcpLaunch(appHome: string): McpLaunch {
  return { command: join(appHome, '.agent-terminal', 'claude-code', MCP_LAUNCHER_NAME), args: [] };
}

export async function refreshMcpLauncher(appHome: string, invocation: McpInvocation): Promise<McpLaunch> {
  const launch = mcpLaunch(appHome);
  const ownBuild = `"$${MCP_WINDOW_EXEC_ENV}"`;
  const script = [
    '#!/bin/sh',
    `if [ "\${1:-}" = ${shellQuote(MCP_HOOK_ARG)} ] && [ -z "\${${MCP_WINDOW_ENV}:-}" ]; then`,
    '  cat >/dev/null',
    '  exit 0',
    'fi',
    `if [ -n "\${${MCP_WINDOW_EXEC_ENV}:-}" ] && [ -x ${ownBuild} ]; then`,
    `  exec env ${NODE_MODE_ASSIGNMENT} ${ownBuild} "$${MCP_WINDOW_SCRIPT_ENV}" "$@"`,
    'fi',
    `[ -x ${shellQuote(invocation.execPath)} ] || exit 0`,
    `exec env ${nodeModeCommand(invocation.execPath, invocation.appArgs)} "$@"`,
    '',
  ].join('\n');
  if (!atomicWriteFileSync(launch.command, script, { mode: 0o755 })) {
    throw new Error(`${path.dirname(launch.command)} is a symbolic link, so the launcher was not written`);
  }
  return launch;
}
