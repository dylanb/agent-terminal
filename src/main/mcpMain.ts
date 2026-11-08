// The agent-terminal MCP server and its Claude Code hooks, run by the installed launcher in plain-Node mode.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MCP_HOOK_ARG, MCP_WINDOW_ENV, mcpAckTimeoutMs } from '../shared/mcp';
import { errMsg } from './errno';
import { mcpBuildId } from './mcpBuildId';
import { createMcpServer } from './mcpServer';

function ownBuild(): string {
  try {
    return mcpBuildId(process.argv[1] ?? '');
  } catch {
    return 'unknown';
  }
}

if (process.argv.slice(2).includes(MCP_HOOK_ARG)) {
  process.stdin.on('error', () => {});
  process.stdin.resume();
} else {
  const endpoint = process.env[MCP_WINDOW_ENV]?.trim() || null;
  const server = createMcpServer({
    endpoint,
    build: ownBuild(),
    ackTimeoutMs: mcpAckTimeoutMs(process.env),
    timers: { setTimer: (cb, ms) => setTimeout(cb, ms), clearTimer: (handle: NodeJS.Timeout) => clearTimeout(handle) },
  });
  server.connect(new StdioServerTransport()).catch((error: unknown) => {
    process.stderr.write(`agent-terminal MCP server failed to start: ${errMsg(error)}\n`);
    process.exitCode = 1;
  });
}
