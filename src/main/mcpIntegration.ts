import type { ClaudeCodeIntegrationResult } from '../shared/ipc';
import type { LaunchInvocation } from './cliShim';
import { errMsg } from './errno';
import { CLAUDE_NOT_FOUND, findClaude, installMcpIntegration, removeMcpIntegration } from './mcpInstall';
import { mcpLaunch, refreshMcpLauncher } from './mcpLauncher';

/** The window's Install and Remove actions. Install rewrites the launcher for the running build first; Remove only
 *  needs to know where it is, so a launcher that can no longer be written never keeps the entries in place. */
export async function changeClaudeCodeIntegration(
  change: 'install' | 'remove',
  ctx: { appHome: string; invocation: LaunchInvocation; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): Promise<ClaudeCodeIntegrationResult> {
  let launch = mcpLaunch(ctx.appHome);
  if (change === 'install') {
    try {
      launch = await refreshMcpLauncher(ctx.appHome, ctx.invocation);
    } catch (error) {
      return { ok: false, error: `The launcher Claude Code runs the agent-terminal tools with could not be written: ${errMsg(error)}` };
    }
  }
  const found = await findClaude(ctx.platform, ctx.env);
  if (found === null) return { ok: false, error: CLAUDE_NOT_FOUND };
  const env = { ...ctx.env, PATH: found.path, ...(found.claudeConfigDir !== undefined ? { CLAUDE_CONFIG_DIR: found.claudeConfigDir } : {}) };
  const target = { claude: found.claude, env, launch };
  return change === 'install' ? installMcpIntegration(target) : removeMcpIntegration(target);
}
