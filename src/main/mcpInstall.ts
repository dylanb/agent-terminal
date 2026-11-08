/** What the install and remove actions act on: the `claude` executable that runs `claude mcp`, the environment
 *  Claude Code runs with (it locates the configuration), and how Claude Code launches the server and its hooks. */
export interface McpIntegrationTarget {
  claude: string;
  env: NodeJS.ProcessEnv;
  launch: { command: string; args: string[] };
}

export type McpIntegrationResult = { ok: true } | { ok: false; error: string };

export async function installMcpIntegration(_target: McpIntegrationTarget): Promise<McpIntegrationResult> {
  return { ok: true };
}

export async function removeMcpIntegration(_target: McpIntegrationTarget): Promise<McpIntegrationResult> {
  return { ok: true };
}
