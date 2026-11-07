import { describe, expect, it } from 'vitest';
import { waitingInTable } from '../../src/main/waitingRule';
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
  const agent = tree.spawn(tree.shell, 'agent');
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
