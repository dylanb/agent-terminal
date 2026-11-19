import type { McpTmux } from '../shared/mcpBridge';
import type { SessionTurns } from './mcpSessionTurns';
import type { AuditRecorder } from './auditRecorder';
import { createAuditObservation } from './auditObservation';

export function createMcpSessionAudit(deps: {
  sessions: Pick<SessionTurns, 'hook' | 'prompt' | 'observe' | 'discoverHumanPrompts' | 'cancelAuditDiscovery'>;
  audit: Pick<AuditRecorder, 'recordPrompts' | 'beginPrompt' | 'forgetPrompt'>;
  repo(): string;
}) {
  const observation = createAuditObservation({
    observe: () => deps.audit.recordPrompts(deps.sessions.discoverHumanPrompts()),
    cancel: () => deps.sessions.cancelAuditDiscovery(),
  });
  return {
    observe: observation.observe,
    close: observation.close,
    async report(session: number, input: unknown, tmux?: McpTmux): Promise<void> {
      const repo = deps.repo();
      void observation.observe();
      const previous = deps.sessions.prompt(session);
      deps.sessions.hook(session, input, tmux);
      const prompt = deps.sessions.prompt(session);
      if (previous && previous.id !== prompt?.id) deps.audit.forgetPrompt(previous);
      if (prompt) deps.audit.beginPrompt(repo, prompt);
      await deps.sessions.observe(session, () => {});
      void observation.observe();
    },
  };
}
