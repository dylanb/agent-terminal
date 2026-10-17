import { describe, expect, it } from 'vitest';
import { agentKindOfCommand, hostedAgentKind } from '../../src/main/agentKind';

// §27.4 (v2.201) — the engine names each reviewer the way the agent in the terminal installs it, so it reads
// which agent is running from the command the terminal is running.

describe('which agent a terminal command runs (§27.4 v2.201)', () => {
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

describe('which agent the terminal is hosting (§27.4 v2.201)', () => {
  const span = (command: string, running: boolean) => ({ command, running });

  it('is the agent of the command that is running', () => {
    expect(hostedAgentKind([span('ls', false), span('codex', true)], '/bin/bash')).toBe('codex');
  });

  it("is the terminal's foreground program when no command span is known", () => {
    expect(hostedAgentKind([], '/usr/local/bin/codex')).toBe('codex');
  });

  it('is the terminal program when the only commands have finished', () => {
    expect(hostedAgentKind([span('codex', false)], '/bin/bash')).toBe('claude-code');
  });
});
