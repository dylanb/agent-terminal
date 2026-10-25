import type { ControllerApi, ControllerTerminal } from '../../src/shared/ipc';

export type WorkStatus = {
  flow: { availability: 'loading' | 'unavailable' } | {
    availability: 'known'; name: string; step: string;
    assignment: 'unassigned' | 'assigned' | 'completed' | 'unavailable';
  };
  ticket: { availability: 'loading' | 'unavailable' | 'none' } | {
    availability: 'known'; number: number;
    title: { availability: 'loading' | 'unavailable' } | { availability: 'known'; text: string };
  };
  activity: 'active' | 'quiet' | 'unavailable';
  attention: null | { status: string; reasons: string[] };
  error: null | { reason: string };
};

export type StatusTerminal = ControllerTerminal & { work: WorkStatus };

export function workStatus(overrides: Partial<WorkStatus> = {}): WorkStatus {
  return {
    flow: { availability: 'known', name: 'feature-dev', step: 'implement', assignment: 'assigned' },
    ticket: { availability: 'known', number: 219, title: { availability: 'known', text: 'Show live controller status' } },
    activity: 'active', attention: null, error: null, ...overrides,
  };
}

export function statusTerminal(overrides: Partial<WorkStatus> = {}): StatusTerminal {
  return { id: 'terminal-a', launchDirectory: '/fixed/worktree', repositoryRoot: '/fixed/repository', work: workStatus(overrides) };
}

export function statusService(initial: StatusTerminal[] = [statusTerminal()]) {
  const listeners = new Set<(items: ControllerTerminal[]) => void>();
  const activated: string[] = [];
  const api: ControllerApi = {
    subscribeTerminals(listener) { listeners.add(listener); listener(initial); return () => { listeners.delete(listener); }; },
    async activateTerminal(id) { activated.push(id); return 'activated'; },
    async dismissTerminal() {},
  };
  return { api, activated, publish(items: StatusTerminal[]) { listeners.forEach(listener => listener(items)); } };
}
