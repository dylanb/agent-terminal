import { describe, expect, it } from 'vitest';
import { agentKindOfCommand, hostedAgentKind, identifiedAgent, sessionAgent } from '../../src/main/agentKind';

// §27.4 — the engine names each reviewer the way the agent in the terminal installs it, so it reads
// which agent is running from the command the terminal is running.

describe('which agent a terminal command runs (§27.4)', () => {
  it.each([
    ['codex', 'codex'],
    ['codex --yolo', 'codex'],
    ['/opt/homebrew/bin/codex resume', 'codex'],
    ['OPENAI_API_KEY=x codex', 'codex'],
    ['env RUST_LOG=info codex', 'codex'],
    ['npx @openai/codex', 'codex'],
    ['npx -y @openai/codex@0.50.0', 'codex'],
    ['nice -n 10 codex', 'codex'],
    ['env -u OPENAI_BASE_URL codex', 'codex'],
    ['npx --package @openai/codex codex', 'codex'],
    ['node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'codex'],
    ['node /Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js --yolo', 'codex'],
    ['node /Users/me/.local/share/claude/cli.js', 'claude-code'],
    ['npm exec @openai/codex', 'codex'],
    ['npm exec -- codex', 'codex'],
    ['pnpm dlx @openai/codex', 'codex'],
    ['yarn dlx @openai/codex', 'codex'],
    ['bun x @openai/codex', 'codex'],
    ['pnpm test', 'claude-code'],
    ['node /opt/homebrew/bin/pnpm dlx @openai/codex', 'codex'],
    ['node /usr/local/bin/npm exec @openai/codex', 'codex'],
    ['env FOO=1 pnpm dlx @openai/codex', 'codex'],
    ['nohup yarn dlx @openai/codex', 'codex'],
    ['pnpm --filter app dlx @openai/codex', 'codex'],
    ['node /usr/local/bin/npm test', 'claude-code'],
    ['yarn run codex', 'codex'],
    ['bun run codex', 'codex'],
    ['node /usr/local/bin/yarn run codex', 'codex'],
    ['deno run -A npm:@openai/codex', 'codex'],
    ['npx -y @anthropic-ai/claude-code --model codex', 'claude-code'],
    ['npx --yes claude -c codex', 'claude-code'],
    ['node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js port the codex adapter', 'claude-code'],
    ['nice -n 10 claude', 'claude-code'],
    ['claude --model codex', 'claude-code'],
    ['claude', 'claude-code'],
    ['claude --resume abc', 'claude-code'],
    ['/Users/me/.local/bin/claude', 'claude-code'],
    ['codexify', 'claude-code'],
    ['', 'claude-code'],
  ])('%j runs %s', (command, kind) => {
    expect(agentKindOfCommand(command)).toBe(kind);
  });
});

describe('which agent the terminal is hosting (§27.4)', () => {
  const span = (command: string, running: boolean) => ({ command, running });

  it('is the agent of the command that is running', () => {
    expect(hostedAgentKind([span('ls', false), span('codex', true)], '/bin/bash')).toBe('codex');
  });

  it("is the terminal's foreground program when no command span is known", () => {
    expect(hostedAgentKind([], '/usr/local/bin/codex')).toBe('codex');
  });

  it('is Codex when the terminal runs Codex under a name the typed command does not show', () => {
    expect(hostedAgentKind([span('cx', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toBe('codex');
  });

  it('is the terminal program when the only commands have finished', () => {
    expect(hostedAgentKind([span('codex', false)], '/bin/bash')).toBe('claude-code');
  });
});

describe('which agent the terminal is hosting, named only when it is recognisably one (Scope 9)', () => {
  const span = (command: string, running: boolean) => ({ command, running });

  it.each([
    ['Claude Code typed', [span('claude', true)], '/bin/bash', 'claude-code'],
    ['Codex typed with options', [span('codex --yolo', true)], '/bin/bash', 'codex'],
    ['Codex typed by its path', [span('/tmp/bin/codex', true)], 'bash /tmp/bin/codex', 'codex'],
    ['Codex run through a package manager', [span('pnpm dlx @openai/codex', true)], '/bin/bash', 'codex'],
    ['Codex under a name the typed command does not show', [span('cx', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js', 'codex'],
    ['Claude Code in the foreground with no command known', [], 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'claude-code'],
  ] as const)('names %s', (_case, spans, foreground, kind) => {
    expect(identifiedAgent(spans, foreground)).toBe(kind);
  });

  it('names the same agent the loop engine drives when a typed Claude Code hands the terminal to Codex', () => {
    const spans = [span('claude', true)];
    const foreground = 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js';
    expect(identifiedAgent(spans, foreground)).toBe('codex');
    expect(hostedAgentKind(spans, foreground)).toBe('codex');
  });

  it.each([
    ['a bare shell', [], '/bin/bash'],
    ['a shell whose agent has exited', [span('claude', false)], '-bash'],
    ['another program', [span('vim notes.md', true)], 'vim notes.md'],
    ['a package script', [span('pnpm test', true)], 'node /usr/local/bin/pnpm test'],
  ] as const)('names no agent for %s', (_case, spans, foreground) => {
    expect(identifiedAgent(spans, foreground)).toBeNull();
  });
});

describe('which agent session the terminal is hosting, for the run\'s record of the agents that ran', () => {
  const span = (command: string, running: boolean) => ({ command, running });

  it.each([
    ['Codex with a prompt', [span('codex "fix the failing test"', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js "fix the failing test"', 'codex'],
    ['Codex resuming a session', [span('codex resume --last', true)], '/bin/bash', 'codex'],
    ['Claude Code', [span('claude', true)], 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', 'claude-code'],
    ['Claude Code printing one answer', [span('claude -p hello', true)], '/bin/bash', 'claude-code'],
  ] as const)('names %s', (_case, spans, foreground, kind) => {
    expect(sessionAgent(spans, foreground)).toBe(kind);
  });

  it.each([
    ['Codex asked its version', [span('codex --version', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js --version'],
    ['Codex logging in', [span('codex login', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js login'],
    ['Codex logging in through a package manager', [span('pnpm dlx @openai/codex login', true)], '/bin/bash'],
    ['Codex managing its MCP servers', [span('codex mcp list', true)], '/bin/bash'],
    ['Codex logging in under a name the typed command does not show', [span('cx login', true)], 'node /usr/local/lib/node_modules/@openai/codex/bin/codex.js login'],
    ['Claude Code asked its version', [span('claude --version', true)], '/bin/bash'],
    ['Claude Code managing its MCP servers', [span('claude mcp list', true)], '/bin/bash'],
    ['Claude Code checking its install', [], 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js doctor'],
  ] as const)('names no session for %s, which writes no session log', (_case, spans, foreground) => {
    expect(sessionAgent(spans, foreground)).toBeNull();
  });
});
