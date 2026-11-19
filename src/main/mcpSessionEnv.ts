import { MCP_WINDOW_ENV, MCP_WINDOW_EXEC_ENV, MCP_WINDOW_SCRIPT_ENV } from '../shared/mcp';
import type { NodeModeRuntime } from './nodeMode';

export function windowSessionEnv(base: NodeJS.ProcessEnv, endpoint: string | null, runtime?: NodeModeRuntime): NodeJS.ProcessEnv {
  const { [MCP_WINDOW_ENV]: _endpoint, [MCP_WINDOW_EXEC_ENV]: _exec, [MCP_WINDOW_SCRIPT_ENV]: _script, ...rest } = base;
  if (endpoint === null) return rest;
  return {
    ...rest,
    [MCP_WINDOW_ENV]: endpoint,
    ...(runtime ? { [MCP_WINDOW_EXEC_ENV]: runtime.execPath, [MCP_WINDOW_SCRIPT_ENV]: runtime.script } : {}),
  };
}
