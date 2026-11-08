import { describe, expect, it } from 'vitest';
import { waitingInTable, waitingPlatform } from '../../src/main/waitingRule';
import { loadProcessTableFixtures, processTree, type TablePlatform } from '../helpers/processTable';

const PLATFORMS: readonly TablePlatform[] = ['darwin', 'linux'];

describe('the Waiting rule on process tables captured from real Claude Code and Codex runs', () => {
  it.each(loadProcessTableFixtures().map((fixture) => [fixture.name, fixture] as const))('%s', (_, fixture) => {
    expect(waitingInTable(fixture.stdout, { shellPid: fixture.shellPid, platform: fixture.platform })).toEqual(fixture.expected);
  });
});

/** An agent in the shell's foreground, as Claude Code and Codex run in a terminal. */
function agentTree(platform: TablePlatform) {
  const tree = processTree({ platform });
  const agent = tree.spawn(tree.shell, 'agent', { group: 'own' });
  tree.foreground(agent);
  return { tree, agent };
}

/** A harness command: a new process group of its own with no controlling terminal, as both harnesses start one. */
const COMMAND = { group: 'own', tty: false } as const;

describe.each(PLATFORMS)('the Waiting rule on %s', (platform) => {
  it('never counts a process younger than a second as a command, however ps rounds its elapsed time', () => {
    const young = (etime: string) => {
      const { tree, agent } = agentTree(platform);
      tree.spawn(agent, 'pytest', { ...COMMAND, etime });
      return waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform });
    };
    const readings = platform === 'darwin' ? ['00:00', '00:01'] : ['00:00'];
    // A real age of 2 s, which the detector tests' RULE_REPORTS_AFTER_MARK_MS assumes the rule reports: procps
    // truncates elapsed time, and the plan has macOS round it up.
    const qualifying = platform === 'darwin' ? '00:03' : '00:02';
    expect({ ...Object.fromEntries(readings.map((etime) => [etime, young(etime)])), [qualifying]: young(qualifying) })
      .toEqual({ ...Object.fromEntries(readings.map((etime) => [etime, null])), [qualifying]: { program: 'pytest', others: 0 } });
  });

  it('names the earliest-started command and counts the others', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'cargo', { ...COMMAND, etime: '00:05' });
    tree.spawn(agent, 'node', { ...COMMAND, etime: '00:40' });
    expect(waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform })).toEqual({ program: 'node', others: 1 });
  });

  it('labels a shell running a pipeline by the pipeline\'s first program, and a shell running nothing by the shell', () => {
    const pipeline = agentTree(platform);
    const shell = pipeline.tree.spawn(pipeline.agent, 'zsh', COMMAND);
    pipeline.tree.spawn(shell, 'node');
    pipeline.tree.spawn(shell, 'tail');
    const bare = agentTree(platform);
    bare.tree.spawn(bare.agent, 'bash', COMMAND);
    expect({
      pipeline: waitingInTable(pipeline.tree.stdout(), { shellPid: pipeline.tree.shell.pid, platform }),
      bare: waitingInTable(bare.tree.stdout(), { shellPid: bare.tree.shell.pid, platform }),
    }).toEqual({ pipeline: { program: 'node', others: 0 }, bare: { program: 'bash', others: 0 } });
  });

  it('counts a command\'s own descendants as part of that one command', () => {
    const { tree, agent } = agentTree(platform);
    const runner = tree.spawn(agent, 'make', COMMAND);
    tree.spawn(tree.spawn(runner, 'cc'), 'ld', { group: 'own', tty: false });
    expect(waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform })).toEqual({ program: 'make', others: 0 });
  });

  it('never counts a process in the agent\'s own process group, or Codex\'s code-mode host, beside a command', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'caffeinate');
    tree.spawn(agent, 'codex-code-mode-host', { group: 'own' });
    tree.spawn(agent, 'pytest', COMMAND);
    expect(waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform })).toEqual({ program: 'pytest', others: 0 });
  });

  it('reads no commands for a program the operator runs at the shell, or for the shell\'s own background job', () => {
    const direct = processTree({ platform });
    const make = direct.spawn(direct.shell, 'make', { group: 'own' });
    direct.foreground(make);
    direct.spawn(make, 'cc');
    const atPrompt = processTree({ platform });
    atPrompt.spawn(atPrompt.shell, 'sleep', { group: 'own' });
    expect({
      direct: waitingInTable(direct.stdout(), { shellPid: direct.shell.pid, platform }),
      atPrompt: waitingInTable(atPrompt.stdout(), { shellPid: atPrompt.shell.pid, platform }),
    }).toEqual({ direct: null, atPrompt: null });
  });
});

describe.each(PLATFORMS)('the Waiting rule\'s helper names and labels on %s', (platform) => {
  it('counts a command the harness runs on a pseudo-terminal of its own', () => {
    const { tree, agent } = agentTree(platform);
    // Its own terminal's foreground is its own group, so ps prints that group as its tpgid.
    const onOwnTerminal = `99001 ${agent.pid} 99001 99001       00:10 vite\n`;
    expect(waitingInTable(tree.stdout() + onOwnTerminal, { shellPid: tree.shell.pid, platform })).toEqual({ program: 'vite', others: 0 });
  });

  it('never counts Codex\'s code-mode host, cut to the OS name limit, even when it runs in a session of its own', () => {
    const { tree, agent } = agentTree(platform);
    tree.spawn(agent, 'codex-code-mode-host', COMMAND);
    tree.spawn(agent, 'pytest', COMMAND);
    expect(waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform })).toEqual({ program: 'pytest', others: 0 });
  });

  it('never counts a shell whose label would come from a helper, or a process with no program name', () => {
    const viaShell = agentTree(platform);
    viaShell.tree.spawn(viaShell.tree.spawn(viaShell.agent, 'sh', COMMAND), 'codex-code-mode-host');
    const unnamed = agentTree(platform);
    unnamed.tree.spawn(unnamed.agent, '', COMMAND);
    expect({
      viaShell: waitingInTable(viaShell.tree.stdout(), { shellPid: viaShell.tree.shell.pid, platform }),
      unnamed: waitingInTable(unnamed.tree.stdout(), { shellPid: unnamed.tree.shell.pid, platform }),
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
      alone: waitingInTable(alone.tree.stdout(), { shellPid: alone.tree.shell.pid, platform }),
      beside: waitingInTable(beside.tree.stdout(), { shellPid: beside.tree.shell.pid, platform }),
    }).toEqual({ alone: null, beside: { program: 'pytest', others: 0 } });
  });

  it('reads an agent and commands running for hours and days, naming the earliest-started', () => {
    const tree = processTree({ platform });
    const agent = tree.spawn(tree.shell, 'agent', { group: 'own', etime: '2-03:04:05' });
    tree.foreground(agent);
    tree.spawn(agent, 'cargo', { ...COMMAND, etime: '59:59' });
    tree.spawn(agent, 'node', { ...COMMAND, etime: '01:00:00' });
    tree.spawn(agent, 'pytest', { ...COMMAND, etime: '1-00:00:05' });
    expect(waitingInTable(tree.stdout(), { shellPid: tree.shell.pid, platform })).toEqual({ program: 'pytest', others: 2 });
  });
});
