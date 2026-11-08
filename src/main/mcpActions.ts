import type { McpCaller, WindowRequest } from '../shared/mcpBridge';
import type { McpWindowState } from '../shared/mcpWindowState';
import type { TurnOrigin } from '../shared/turnOrigin';
import type { AutoGate } from './autoGate';
import type { HumanApproveDeps } from './autoGateComposition';

/** The loop gate an approve acts on, as `read_state` names it. */
export interface GateTarget {
  repoKey: string;
  step: string;
  turnKey: string;
}

export interface McpActionDeps {
  windowId: string;
  originOf(caller: McpCaller): Promise<TurnOrigin>;
  readState(): Promise<McpWindowState>;
  /** What the window's own Approve control decides with: an MCP approve runs the same human approve over them. */
  gate: HumanApproveDeps & { autoGate: Pick<AutoGate, 'humanDecision'> };
}

/** The window's answer to a tool call, which the server turns into the call's tool result. */
export function createMcpActions(_deps: McpActionDeps): { call(request: WindowRequest, caller: McpCaller): Promise<unknown> } {
  return { call: async () => ({}) };
}
