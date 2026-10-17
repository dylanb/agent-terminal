// §27.4

import path from 'node:path';

export type AgentKind = 'claude-code' | 'codex';

const LAUNCHERS: ReadonlySet<string> = new Set(['env', 'exec', 'command', 'npx', 'bunx', 'pnpx', 'nice', 'nohup']);

function programName(token: string): string {
  const base = token.startsWith('@') ? token : path.basename(token);
  const at = base.indexOf('@', 1);
  return at > 0 ? base.slice(0, at) : base;
}

export function agentKindOfCommand(command: string): AgentKind {
  for (const token of command.trim().split(/\s+/)) {
    if (token === '' || token.includes('=') || token.startsWith('-')) continue;
    const name = programName(token);
    if (LAUNCHERS.has(name)) continue;
    return name === 'codex' || name === '@openai/codex' ? 'codex' : 'claude-code';
  }
  return 'claude-code';
}

export function hostedAgentKind(spans: readonly { command: string; running: boolean }[], terminalProgram: string): AgentKind {
  const running = spans.filter((s) => s.running);
  return agentKindOfCommand(running.length > 0 ? running[running.length - 1].command : terminalProgram);
}
