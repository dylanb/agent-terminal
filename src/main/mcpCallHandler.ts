import { parseMcpCommand, type McpCommand } from './mcpTools';
import type { WindowRequest, McpCaller } from '../shared/mcpBridge';
import type { SessionTurns } from './mcpSessionTurns';
import type { AuditRecorder } from './auditRecorder';
import type { McpActionResult } from './mcpActionResult';
import type { TurnOrigin } from '../shared/turnOrigin';

export function createMcpCallHandler(deps: {
  repo(): string;
  sessions: Pick<SessionTurns, 'observe'>;
  audit: Pick<AuditRecorder, 'recordMcpCall'>;
  actions: { execute(command: McpCommand, caller: McpCaller, origin: TurnOrigin): Promise<McpActionResult> };
}): (request: WindowRequest, caller: McpCaller) => Promise<McpActionResult> {
  return (request, caller) => {
    const repo = deps.repo();
    return deps.sessions.observe(caller.session, ({ origin, prompt }) =>
      deps.audit.recordMcpCall(repo, request.tool, origin, prompt, async () => {
        const parsed = parseMcpCommand(request.tool, request.args);
        return parsed.ok ? deps.actions.execute(parsed.command, caller, origin)
          : { outcome: 'neither', kind: 'invalid-arguments', message: parsed.reason };
      }));
  };
}
