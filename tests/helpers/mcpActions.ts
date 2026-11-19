import type { McpGateOperations } from '../../src/main/mcpGateOperations';
import { parseMcpCommand } from '../../src/main/mcpTools';
import type { WindowRequest } from '../../src/shared/mcpBridge';
import type { TurnOrigin } from '../../src/shared/turnOrigin';
import type { McpCaller } from '../../src/shared/mcpBridge';
import { createMcpActions, type McpActionDeps } from '../../src/main/mcpActions';

const unexpected = (): never => { throw new Error('Unexpected operation in this test'); };

export function mcpActions(overrides: Pick<McpActionDeps, 'windowId' | 'readState' | 'readActionState'> & Partial<McpActionDeps> & { originOf(caller: McpCaller): Promise<TurnOrigin> }) {
  const actions = createMcpActions({
    gate: testGateOperations(),
    todos: { list: unexpected, add: unexpected, update: unexpected, reorder: unexpected, setStatus: unexpected, delete: unexpected },
    captureReport: unexpected, sendTodo: unexpected, entryStatus: () => null,
    retry: unexpected, dismissLoopMessage: unexpected, chooseFlow: unexpected,
    validateEntryInputs: () => ({ valid: true }), start: unexpected, terminate: unexpected, advance: unexpected,
    ...overrides,
  });
  return { execute: actions.execute, async call(request: WindowRequest, caller: McpCaller, observed?: TurnOrigin) {
    const origin = observed ?? await overrides.originOf(caller);
    const parsed = parseMcpCommand(request.tool, request.args);
    return parsed.ok ? actions.execute(parsed.command, caller, origin) : { outcome: 'neither' as const, kind: 'invalid-arguments', message: parsed.reason };
  } };
}

export function testGateOperations(overrides: Partial<McpGateOperations> = {}): McpGateOperations {
  return { pickupHold: () => null, refusal: () => null, approve: unexpected, decide: unexpected, ...overrides };
}
