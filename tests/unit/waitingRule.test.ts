import { describe, expect, it } from 'vitest';
import { parseProcessTable } from '../../src/main/waitingLookup';
import { waitingInTable, waitingPlatform } from '../../src/main/waitingRule';
import { loadProcessTableFixtures, processTree, type TablePlatform } from '../helpers/processTable';

const PLATFORMS: readonly TablePlatform[] = ['darwin', 'linux'];

describe('the Waiting rule on process tables captured from real Claude Code and Codex runs', () => {
  it.each(loadProcessTableFixtures().map((fixture) => [fixture.name, fixture] as const))('%s', (_, fixture) => {
    expect(waitingInTable(parseProcessTable(fixture.stdout), { shellPid: fixture.shellPid, platform: fixture.platform, helpers: [] })).toEqual(fixture.expected);
  });
});

function agentTree(platform: TablePlatform) {
  const tree = processTree({ platform });
  const agent = tree.spawn(tree.shell, 'agent', { group: 'own' });
  tree.foreground(agent);
  return { tree, agent };
}

const COMMAND = { group: 'own', tty: false } as const;

describe.each(PLATFORMS)('the Waiting rule on %s', (platform) => {
  it('never counts a process younger than a second as a command, however ps rounds its elapsed time', () => {
    const reading = (elapsedS: number) => {
      const { tree, agent } = agentTree(platform);
      tree.spawn(agent, 'pytest', { ...COMMAND, elapsedS });
      return waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] });
    };
    expect([0, 1, 2, 3].map(reading)).toEqual([null, null, { program: 'pytest', others: 0 }, { program: 'pytest', others: 0 }]);
  });

  it('names the earliest-started command and counts the others', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'cargo', { ...COMMAND, elapsedS: 5 });
    tree.spawn(agent, 'node', { ...COMMAND, elapsedS: 40 });
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'node', others: 1 });
  });

  it('labels a shell running a pipeline by the pipeline\'s first program, and a shell running nothing by the shell', () => {
    const pipeline = agentTree(platform);
    const shell = pipeline.tree.spawn(pipeline.agent, 'zsh', COMMAND);
    pipeline.tree.spawn(shell, 'node');
    pipeline.tree.spawn(shell, 'tail');
    const bare = agentTree(platform);
    bare.tree.spawn(bare.agent, 'bash', COMMAND);
    expect({
      pipeline: waitingInTable(pipeline.tree.rows(), { shellPid: pipeline.tree.shell.pid, platform, helpers: [] }),
      bare: waitingInTable(bare.tree.rows(), { shellPid: bare.tree.shell.pid, platform, helpers: [] }),
    }).toEqual({ pipeline: { program: 'node', others: 0 }, bare: { program: 'bash', others: 0 } });
  });

  it('counts a command\'s own descendants as part of that one command', () => {
    const { tree, agent } = agentTree(platform);
    const runner = tree.spawn(agent, 'make', COMMAND);
    tree.spawn(tree.spawn(runner, 'cc'), 'ld', { group: 'own', tty: false });
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'make', others: 0 });
  });

  it('never counts a process in the agent\'s own process group, or Codex\'s code-mode host, beside a command', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'caffeinate');
    tree.spawn(agent, 'codex-code-mode-host', { group: 'own' });
    tree.spawn(agent, 'pytest', COMMAND);
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'pytest', others: 0 });
  });

  it('reads no commands for a program the operator runs at the shell, or for the shell\'s own background job', () => {
    const direct = processTree({ platform });
    const make = direct.spawn(direct.shell, 'make', { group: 'own' });
    direct.foreground(make);
    direct.spawn(make, 'cc');
    const atPrompt = processTree({ platform });
    atPrompt.spawn(atPrompt.shell, 'sleep', { group: 'own' });
    expect({
      direct: waitingInTable(direct.rows(), { shellPid: direct.shell.pid, platform, helpers: [] }),
      atPrompt: waitingInTable(atPrompt.rows(), { shellPid: atPrompt.shell.pid, platform, helpers: [] }),
    }).toEqual({ direct: null, atPrompt: null });
  });
});

describe.each(PLATFORMS)('the Waiting rule\'s helper names and labels on %s', (platform) => {
  it('counts a command the harness runs on a pseudo-terminal of its own', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'vite', { group: 'own', tty: 'own' });
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'vite', others: 0 });
  });

  it('never counts Codex\'s code-mode host, cut to the OS name limit, even when it runs in a session of its own', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'codex-code-mode-host', COMMAND);
    tree.spawn(agent, 'pytest', COMMAND);
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'pytest', others: 0 });
  });

  it('never counts a shell whose label would come from a helper, or a process with no program name', () => {
    const viaShell = agentTree(platform);
    viaShell.tree.spawn(viaShell.tree.spawn(viaShell.agent, 'sh', COMMAND), 'codex-code-mode-host');
    const unnamed = agentTree(platform);
    unnamed.tree.spawn(unnamed.agent, '', COMMAND);
    expect({
      viaShell: waitingInTable(viaShell.tree.rows(), { shellPid: viaShell.tree.shell.pid, platform, helpers: [] }),
      unnamed: waitingInTable(unnamed.tree.rows(), { shellPid: unnamed.tree.shell.pid, platform, helpers: [] }),
    }).toEqual({ viaShell: null, unnamed: null });
  });
});

describe('the platforms the Waiting rule reads', () => {
  it('reads macOS and Linux, and no other platform', () => {
    expect(['darwin', 'linux', 'win32', 'freebsd'].map(waitingPlatform)).toEqual(['darwin', 'linux', null, null]);
  });
});

describe.each(PLATFORMS)('the Waiting rule on helpers\' descendants and long-running processes on %s', (platform) => {
  it('never counts a process a helper in the agent\'s group started in a session of its own, as a browser an MCP server starts', () => {
    const alone = agentTree(platform);
    alone.tree.spawn(alone.tree.spawn(alone.agent, 'node'), 'chrome', COMMAND);
    const beside = agentTree(platform);
    beside.tree.spawn(beside.tree.spawn(beside.agent, 'node'), 'chrome', COMMAND);
    beside.tree.spawn(beside.agent, 'pytest', COMMAND);
    expect({
      alone: waitingInTable(alone.tree.rows(), { shellPid: alone.tree.shell.pid, platform, helpers: [] }),
      beside: waitingInTable(beside.tree.rows(), { shellPid: beside.tree.shell.pid, platform, helpers: [] }),
    }).toEqual({ alone: null, beside: { program: 'pytest', others: 0 } });
  });

  it('reads an agent and commands running for hours and days, naming the earliest-started', () => {
    const tree = processTree({ platform });
    const agent = tree.spawn(tree.shell, 'agent', { group: 'own', elapsedS: 183_845 });
    tree.foreground(agent);
    tree.spawn(agent, 'cargo', { ...COMMAND, elapsedS: 3599 });
    tree.spawn(agent, 'node', { ...COMMAND, elapsedS: 3600 });
    tree.spawn(agent, 'pytest', { ...COMMAND, elapsedS: 86_405 });
    expect(waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers: [] })).toEqual({ program: 'pytest', others: 2 });
  });
});

describe.each(PLATFORMS)('the Waiting rule on the operator\'s helper names on %s', (platform) => {
  it('never counts a process the operator lists, beside the built-in ones, by its own name or as the program its shell runs, and still counts one it does not', () => {
    const direct = agentTree(platform);
    direct.tree.spawn(direct.agent, 'my-lsp', COMMAND);
    direct.tree.spawn(direct.agent, 'codex-code-mode-host', COMMAND);
    direct.tree.spawn(direct.agent, 'pytest', COMMAND);
    const viaShell = agentTree(platform);
    viaShell.tree.spawn(viaShell.tree.spawn(viaShell.agent, 'sh', COMMAND), 'my-lsp');
    const unlisted = agentTree(platform);
    unlisted.tree.spawn(unlisted.agent, 'my-lsp', COMMAND);
    const nested = agentTree(platform);
    nested.tree.spawn(nested.tree.spawn(nested.agent, 'pytest', COMMAND), 'my-lsp');
    const noneListed = agentTree(platform);
    noneListed.tree.spawn(noneListed.agent, 'codex-code-mode-host', COMMAND);
    noneListed.tree.spawn(noneListed.agent, 'pytest', COMMAND);
    expect({
      direct: waitingInTable(direct.tree.rows(), { shellPid: direct.tree.shell.pid, platform, helpers: ['my-lsp'] }),
      viaShell: waitingInTable(viaShell.tree.rows(), { shellPid: viaShell.tree.shell.pid, platform, helpers: ['my-lsp'] }),
      unlisted: waitingInTable(unlisted.tree.rows(), { shellPid: unlisted.tree.shell.pid, platform, helpers: ['other-lsp'] }),
      nested: waitingInTable(nested.tree.rows(), { shellPid: nested.tree.shell.pid, platform, helpers: ['my-lsp'] }),
      noneListed: waitingInTable(noneListed.tree.rows(), { shellPid: noneListed.tree.shell.pid, platform, helpers: [] }),
    }).toEqual({ direct: { program: 'pytest', others: 0 }, viaShell: null, unlisted: { program: 'my-lsp', others: 0 }, nested: { program: 'pytest', others: 0 }, noneListed: { program: 'pytest', others: 0 } });
  });

  it('matches a listed name exactly, after cutting one longer than the OS name limit to that limit', () => {
    const read = (program: string, helpers: readonly string[]) => {
      const { tree, agent } = agentTree(platform);
      tree.spawn(agent, program, COMMAND);
      return waitingInTable(tree.rows(), { shellPid: tree.shell.pid, platform, helpers });
    };
    expect({
      longListed: read('my-language-server', ['my-language-server']),
      prefixListed: read('pytest', ['pytes']),
      longerListed: read('pytest', ['pytest-x']),
    }).toEqual({ longListed: null, prefixListed: { program: 'pytest', others: 0 }, longerListed: { program: 'pytest', others: 0 } });
  });
});
