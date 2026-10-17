// §27.4

import path from 'node:path';

export type AgentKind = 'claude-code' | 'codex';

const LAUNCHERS: ReadonlySet<string> = new Set(['env', 'exec', 'command', 'npx', 'bunx', 'pnpx', 'nice', 'nohup', 'node', 'bun', 'deno']);

// A package manager runs a package through one of these subcommands, e.g. `pnpm dlx @openai/codex`.
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUN_SUBCOMMANDS: ReadonlySet<string> = new Set(['exec', 'dlx', 'x']);

// The npm package's entry script, which `node` runs for an npm or pnpm install of Codex.
const CODEX_PACKAGE_SEGMENT = '/@openai/codex/';

function programName(token: string): string {
  const base = token.startsWith('@') ? token : path.basename(token);
  const at = base.indexOf('@', 1);
  return at > 0 ? base.slice(0, at) : base;
}

const isCodex = (token: string, name: string): boolean => name === 'codex' || name === '@openai/codex' || token.includes(CODEX_PACKAGE_SEGMENT);

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
    const optionValue = launched && afterFlag && !isCodex(token, name);
    afterFlag = false;
    if (optionValue) continue;
    if (LAUNCHERS.has(name)) {
      launched = true;
      continue;
    }
    return isCodex(token, name) ? 'codex' : 'claude-code';
  }
  return 'claude-code';
}

export function hostedAgentKind(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind {
  const running = spans.filter((s) => s.running);
  const typed = running.length > 0 ? agentKindOfCommand(running[running.length - 1].command) : 'claude-code';
  return typed === 'codex' ? typed : agentKindOfCommand(foregroundProgram);
}
