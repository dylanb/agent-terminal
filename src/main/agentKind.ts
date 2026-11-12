// §27.4

import path from 'node:path';
import type { AgentKind } from '../shared/agentKind';

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

// The first argument of an agent command that only manages the agent: no session, so no session log.
const NOT_A_SESSION: Record<AgentKind, ReadonlySet<string>> = {
  codex: new Set(['--version', '-V', '--help', '-h', 'help', 'login', 'logout', 'mcp', 'mcp-server', 'completion', 'apply', 'sandbox', 'debug']),
  'claude-code': new Set(['--version', '-v', '-V', '--help', '-h', 'auth', 'mcp', 'plugin', 'config', 'doctor', 'install', 'update', 'setup-token']),
};

/** The agent `command` runs and the arguments after it, or `null` when it runs none recognisably. */
function agentCall(command: string): { agent: AgentKind; args: string[] } | null {
  let launched = false;
  let afterFlag = false;
  let afterManager = false;
  const tokens = command.trim().split(/\s+/);
  for (const [i, token] of tokens.entries()) {
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
    if (isCodex(token, name)) return { agent: 'codex', args: tokens.slice(i + 1) };
    if (isClaudeCode(token, name)) return { agent: 'claude-code', args: tokens.slice(i + 1) };
    const optionValue = launched && afterFlag;
    afterFlag = false;
    if (optionValue) continue;
    if (LAUNCHERS.has(name)) {
      launched = true;
      continue;
    }
    return null;
  }
  return null;
}

const commandAgent = (command: string): AgentKind | null => agentCall(command)?.agent ?? null;

/** Whether `command` runs an agent only to manage it, such as `codex login` or `claude --version`. */
function managesAgent(command: string): boolean {
  const call = agentCall(command);
  return call !== null && NOT_A_SESSION[call.agent].has(call.args[0] ?? '');
}

export function agentKindOfCommand(command: string): AgentKind {
  return commandAgent(command) ?? 'claude-code';
}

export function identifiedAgent(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind | null {
  const running = spans.filter((s) => s.running).at(-1);
  const typed = running === undefined ? null : commandAgent(running.command);
  return typed === 'codex' ? typed : (commandAgent(foregroundProgram) ?? typed);
}

/** The agent the terminal runs as a session, the kind that writes a session log; `null` while it only manages one. */
export function sessionAgent(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind | null {
  const running = spans.filter((s) => s.running).at(-1);
  if ((running !== undefined && managesAgent(running.command)) || managesAgent(foregroundProgram)) return null;
  return identifiedAgent(spans, foregroundProgram);
}

export function hostedAgentKind(spans: readonly { command: string; running: boolean }[], foregroundProgram: string): AgentKind {
  return identifiedAgent(spans, foregroundProgram) ?? 'claude-code';
}
