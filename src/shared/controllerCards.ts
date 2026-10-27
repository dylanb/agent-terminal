import type { ControllerTerminal } from './ipc';

export interface ControllerDirectoryCard extends ControllerTerminal {
  instanceCount: number;
  liveIds: readonly string[];
}

export function directoryCards(terminals: readonly ControllerTerminal[]): ControllerDirectoryCard[] {
  const groups = new Map<string, ControllerTerminal[]>();
  for (const terminal of terminals) {
    const members = groups.get(terminal.launchDirectory) ?? [];
    members.push(terminal);
    groups.set(terminal.launchDirectory, members);
  }
  return [...groups.values()].map(members => {
    const live = members.filter(member => member.status !== 'disconnected');
    const shown = live.length ? live : members;
    const first = shown[0];
    return {
      ...first,
      repositoryRoot: shown.every(member => member.repositoryRoot === first.repositoryRoot) ? first.repositoryRoot : null,
      work: live.length === 1 ? first.work : undefined,
      instanceCount: live.length,
      liveIds: live.map(member => member.id),
    };
  });
}
