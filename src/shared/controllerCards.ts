import type { ControllerTerminal, ControllerWorkStatus } from './ipc';

interface DirectoryIdentity {
  readonly launchDirectory: string;
  readonly repositoryRoot: string | null;
}

export type ControllerDirectoryCard = DirectoryIdentity & (
  | { readonly kind: 'single'; readonly notifications?: ControllerTerminal['notifications']; readonly clearHistoryTarget?: ControllerTerminal['clearHistoryTarget']; readonly work?: ControllerWorkStatus; readonly activationTargets: readonly [string] }
  | { readonly kind: 'conflict'; readonly activationTargets: readonly [string, string, ...string[]] }
  | { readonly kind: 'disconnected'; readonly notifications?: ControllerTerminal['notifications']; readonly clearHistoryTarget?: ControllerTerminal['clearHistoryTarget']; readonly dismissOccurrenceId: string }
);

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
    const identity = {
      launchDirectory: first.launchDirectory,
      repositoryRoot: shown.every(member => member.repositoryRoot === first.repositoryRoot) ? first.repositoryRoot : null,
    };
    if (!live.length) return { ...identity, kind: 'disconnected', notifications: structuredClone(first.notifications), clearHistoryTarget: structuredClone(first.clearHistoryTarget), dismissOccurrenceId: first.id };
    if (live.length === 1) return { ...identity, kind: 'single', notifications: structuredClone(first.notifications), clearHistoryTarget: structuredClone(first.clearHistoryTarget), work: structuredClone(first.work), activationTargets: [first.id] };
    return { ...identity, kind: 'conflict', activationTargets: [live[0].id, live[1].id, ...live.slice(2).map(member => member.id)] };
  });
}
