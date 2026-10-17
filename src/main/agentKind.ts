// §27.4

import path from 'node:path';

export type AgentKind = 'claude-code' | 'codex';

const LAUNCHERS: ReadonlySet<string> = new Set(['env', 'exec', 'command', 'npx', 'bunx', 'pnpx', 'nice', 'nohup', 'node', 'bun', 'deno']);

// A package manager runs a package through one of these subcommands, e.g. `pnpm dlx @openai/codex`.
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun', 'deno']);
const RUN_SUBCOMMANDS: ReadonlySet<string> = new Set(['exec', 'dlx', 'x', 'run']);

// The npm packages' entry scripts, which `node` runs for an npm or pnpm install of each agent.
const CODEX_PACKAGE_SEGMENT = '/@openai/codex/';
const CLAUDE_PACKAGE_SEGMENT = '/@anthropic-ai/claude-code/';

function programName(token: string): string {
  const spec = token.startsWith('npm:') ? token.slice('npm:'.length) : token;
  const base = spec.startsWith('@') ? spec : path.basename(spec);
  const at = base.indexOf('@', 1);
  return at > 0 ? base.slice(0, at) : base;
}

const isCodex = (token: string, name: string): boolean => name === 'codex' || name === '@openai/codex' || token.includes(CODEX_PACKAGE_SEGMENT);
const isClaudeCode = (token: string, name: string): boolean =>
  name === 'claude' || name === '@anthropic-ai/claude-code' || token.includes(CLAUDE_PACKAGE_SEGMENT);

export function agentKindOfCommand(command: string): AgentKind {
  let launched = false;
  let afterFlag = false;
  let afterManager = false;
  for (const token of command.trim().split(/\s+/)) {
    if (token === '' || token.includes('=')) continue;
    if (token.startsWith('-')) {
      afterFlag = true;
      continue;
    }
    const name = programName(token);
    if (afterManager && RUN_SUBCOMMANDS.has(name)) {
      afterManager = false;
      afterFlag = false;
      continue;
    }
    if (PACKAGE_MANAGERS.has(name)) {
      launched = true;
      afterManager = true;
      afterFlag = false;
      continue;
    }
    if (isCodex(token, name)) return 'codex';
    if (isClaudeCode(token, name)) return 'claude-code';
    const optionValue = launched && afterFlag;
    afterFlag = false;
    if (optionValue) continue;
    if (LAUNCHERS.has(name)) {
      launched = true;
      continue;
    }
    return 'claude-code';
  }
  return 'claude-code';
}

export function hostedAgentKind(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind {
  const running = spans.filter((s) => s.running);
  const typed = running.length > 0 ? agentKindOfCommand(running[running.length - 1].command) : 'claude-code';
  return typed === 'codex' ? typed : agentKindOfCommand(foregroundProgram);
}
