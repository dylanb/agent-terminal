// The agent-terminal MCP server and its Claude Code hooks, run by the installed launcher in plain-Node mode.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_HOOK_ARG, MCP_HOOK_REPORT, MCP_WINDOW_ENV, mcpAckTimeoutMs } from '../shared/mcp';
import { isMcpTmux, type AckTimers } from '../shared/mcpBridge';
import { errMsg } from './errno';
import { mcpBuildId } from './mcpBuildId';
import { createMcpServer } from './mcpServer';
import { claudeSessionOf, readProcessEntry } from './mcpSessionProcess';
import { callWindow } from './mcpWindowClient';

function ownBuild(): string {
  try {
    return mcpBuildId(process.argv[1] ?? '');
  } catch {
    return 'unknown';
  }
}

const endpoint = process.env[MCP_WINDOW_ENV]?.trim() || null;
const ackTimeoutMs = mcpAckTimeoutMs(process.env);
const timers: AckTimers<NodeJS.Timeout> = { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (handle) => clearTimeout(handle) };
const tmux = { socket: /^(.*),\d+,\d+$/.exec(process.env.TMUX ?? '')?.[1], searchPath: process.env.PATH };
const caller = () => ({
  session: claudeSessionOf(process.ppid, readProcessEntry),
  ...(isMcpTmux(tmux) ? { tmux } : {}),
});

/** Hands the window Claude Code's hook input. Claude Code waits on the hook, so the window, which answers a report
 *  as soon as it reads it, gets the ack timeout for the whole exchange; the hook always exits 0 and prints nothing. */
async function reportHook(): Promise<void> {
  process.stdin.on('error', () => {});
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  if (endpoint === null) return;
  let input: unknown = null;
  try {
    input = JSON.parse(raw);
  } catch {
    input = null;
  }
  const deadline = setTimeout(() => process.exit(0), ackTimeoutMs);
  await callWindow(endpoint, { tool: MCP_HOOK_REPORT, args: input }, { build: ownBuild(), ackTimeoutMs, timers, caller: caller() });
  clearTimeout(deadline);
}

if (process.argv.slice(2).includes(MCP_HOOK_ARG)) {
  reportHook().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
} else {
  const server = createMcpServer({ endpoint, build: ownBuild(), ackTimeoutMs, timers, ...(endpoint === null ? {} : { caller: caller() }) });
  server.connect(new StdioServerTransport()).catch((error: unknown) => {
    process.stderr.write(`agent-terminal MCP server failed to start: ${errMsg(error)}\n`);
    process.exitCode = 1;
  });
}
