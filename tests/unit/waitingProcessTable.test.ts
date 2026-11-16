import { describe, expect, it } from 'vitest';
import { parseProcessTable } from '../../src/main/waitingLookup';
import { processTree, type TablePlatform } from '../helpers/processTable';

const PLATFORMS: readonly TablePlatform[] = ['darwin', 'linux'];

describe.each(PLATFORMS)('reading a ps process table on %s', (platform) => {
  it('reads every process, with its group, its terminal\'s foreground group, its age and its program', () => {
    const tree = processTree({ platform });
    const agent = tree.spawn(tree.shell, 'agent', { group: 'own' });
    tree.foreground(agent);
    tree.spawn(agent, 'caffeinate');
    tree.spawn(agent, 'pytest', { group: 'own', tty: false });
    tree.spawn(agent, 'vite', { group: 'own', tty: 'own' });
    tree.spawn(agent, '', { group: 'own', tty: false });
    expect(parseProcessTable(tree.stdout())).toEqual(tree.rows());
  });

  it('reads elapsed times of seconds, minutes, hours and days', () => {
    const tree = processTree({ platform });
    for (const elapsedS of [0, 1, 3, 59, 3599, 3600, 86_399, 86_405, 183_845]) tree.spawn(tree.shell, 'sleep', { elapsedS });
    expect(parseProcessTable(tree.stdout()).map((row) => row.elapsedS)).toEqual([7200, 0, 1, 3, 59, 3599, 3600, 86_399, 86_405, 183_845]);
  });
});

describe('reading ps lines the processes did not shape', () => {
  it('keeps a program name that has spaces, and skips blank and malformed lines', () => {
    const table = [
      '',
      '  4100  4099  4100  4123    02:00:00 zsh',
      '  4123  4100  4123  4123       00:07 Google Chrome',
      'not a process row',
      '  4200  4123  4200     0   xx:yy pytest',
      '',
    ].join('\n');
    expect(parseProcessTable(table)).toEqual([
      { pid: 4100, ppid: 4099, pgid: 4100, tpgid: 4123, elapsedS: 7200, program: 'zsh' },
      { pid: 4123, ppid: 4100, pgid: 4123, tpgid: 4123, elapsedS: 7, program: 'Google Chrome' },
    ]);
  });
});
