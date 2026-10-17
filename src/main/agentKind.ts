// §27.4

import path from 'node:path';

export type AgentKind = 'claude-code' | 'codex';

const LAUNCHERS: ReadonlySet<string> = new Set(['env', 'exec', 'command', 'npx', 'bunx', 'pnpx', 'nice', 'nohup']);

function programName(token: string): string {
  const base = token.startsWith('@') ? token : path.basename(token);
  const at = base.indexOf('@', 1);
  return at > 0 ? base.slice(0, at) : base;
}

const isCodex = (name: string): boolean => name === 'codex' || name === '@openai/codex';

export function agentKindOfCommand(command: string): AgentKind {
  let launched = false;
  let afterFlag = false;
  for (const token of command.trim().split(/\s+/)) {
    if (token === '' || token.includes('=')) continue;
    if (token.startsWith('-')) {
      afterFlag = true;
      continue;
    }
    const name = programName(token);
    const optionValue = launched && afterFlag && !isCodex(name);
    afterFlag = false;
    if (optionValue) continue;
    if (LAUNCHERS.has(name)) {
      launched = true;
      continue;
    }
    return isCodex(name) ? 'codex' : 'claude-code';
  }
  return 'claude-code';
}

export function hostedAgentKind(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind {
  const running = spans.filter((s) => s.running);
  return agentKindOfCommand(running.length > 0 ? running[running.length - 1].command : foregroundProgram);
}
