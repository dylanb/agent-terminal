import { describe, expect, it } from 'vitest';
import { claudeSessionOf, type ProcessEntry } from '../../src/main/mcpSessionProcess';
import { parseSessionLaunch } from '../../src/main/mcpSessionTurns';

// Which Claude Code session a server or hook process belongs to, and how that session was launched, read from the
// process table (#322 slice 2).

const LAUNCHER = '/home/op/.agent-terminal/claude-code/agent-terminal-mcp';
const CLAUDE = 700;

describe('the Claude Code session a server or hook runs for', () => {
  const table = (entries: Record<number, ProcessEntry>) => (pid: number): ProcessEntry | null => entries[pid] ?? null;

  it('is the parent when Claude Code ran the launcher itself, and the shell’s parent when it ran it through a hook shell', () => {
    const processes = table({
      [CLAUDE]: { ppid: 600, args: 'node /usr/local/bin/claude' },
      701: { ppid: CLAUDE, args: `/bin/sh -c '${LAUNCHER}' --hook` },
      702: { ppid: 701, args: `/bin/sh ${LAUNCHER} --hook` },
    });
    expect({ server: claudeSessionOf(CLAUDE, processes), hookShell: claudeSessionOf(701, processes), unexecLauncher: claudeSessionOf(702, processes) }).toEqual({
      server: CLAUDE,
      hookShell: CLAUDE,
      unexecLauncher: CLAUDE,
    });
  });

  it('is unknown when the process table cannot say', () => {
    const missingParent = table({ 701: { ppid: CLAUDE, args: `/bin/sh -c '${LAUNCHER}' --hook` } });
    expect({ unreadable: claudeSessionOf(CLAUDE, () => null), missingParent: claudeSessionOf(701, missingParent) }).toEqual({ unreadable: null, missingParent: null });
  });
});

describe('how a Claude Code session was launched, from its command line', () => {
  it.each([
    ['claude', { print: false, launchPrompt: false }],
    ['node /usr/local/bin/claude --model opus --permission-mode plan', { print: false, launchPrompt: false }],
    ['/opt/homebrew/bin/claude -p mcp approve {}', { print: true, launchPrompt: true }],
    ['claude --print', { print: true, launchPrompt: false }],
    ['claude approve the gate please', { print: false, launchPrompt: true }],
    ['node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --add-dir /tmp hello', { print: false, launchPrompt: true }],
    ['claude --resume 4f2a9c1e', { print: false, launchPrompt: false }],
    ['claude -r 4f2a9c1e --model opus', { print: false, launchPrompt: false }],
    ['claude --resume --model opus', { print: false, launchPrompt: false }],
  ])('%s', (args, launch) => {
    expect(parseSessionLaunch(args)).toEqual(launch);
  });

  it('is unknown for a command line that is not Claude Code’s', () => {
    expect({ shell: parseSessionLaunch('-zsh'), empty: parseSessionLaunch('') }).toEqual({ shell: null, empty: null });
  });
});
