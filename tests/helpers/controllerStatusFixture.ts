import type { ControllerApi, ControllerTerminal, ControllerWorkStatus, Theme } from '../../src/shared/ipc';
import type { CardStatusClass as Status } from '../../src/renderer/src/controllerCardStatus';

export type WorkStatus = ControllerWorkStatus;

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

export const SUMMARY_LABELS = ['errors', 'need a human', 'idle', 'working'] as const;
export type SummaryLabel = (typeof SUMMARY_LABELS)[number];

export interface StatusCase {
  terminal: ControllerTerminal;
  text: string;
  statusClass: Status;
  summary: SummaryLabel;
}

const caseTerminal = (key: string, work: WorkStatus | undefined, status?: 'disconnected'): ControllerTerminal => ({
  id: `case-${key}`, launchDirectory: `/cases/${key}/worktree`, repositoryRoot: `/cases/${key}`,
  ...(work ? { work } : {}), ...(status ? { status } : {}),
});
const running = { availability: 'known', name: 'feature-dev', step: 'implement', assignment: 'assigned' } as const;
const human = { status: 'needs a human', reasons: ['Approve the plan'] };
const failure = { reason: 'Step exited 1' };

const CASES = {
  disconnected: [caseTerminal('disconnected', undefined, 'disconnected'), 'Disconnected', 'error', 'errors'],
  'disconnected-with-error': [caseTerminal('disconnected-with-error', workStatus({ error: failure, attention: human }), 'disconnected'), 'Disconnected', 'error', 'errors'],
  'flow-error': [caseTerminal('flow-error', workStatus({ error: failure })), 'Flow error', 'error', 'errors'],
  'flow-error-and-human': [caseTerminal('flow-error-and-human', workStatus({ error: failure, attention: human })), 'Flow error', 'error', 'errors'],
  'needs-human': [caseTerminal('needs-human', workStatus({ attention: human, activity: 'active' })), 'Needs a human', 'needs-human', 'need a human'],
  oversized: [caseTerminal('oversized', {
    flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' },
    activity: 'unavailable', attention: null, error: null, unavailableReason: 'message-too-large',
  }), 'Status unavailable', 'needs-human', 'need a human'],
  loading: [caseTerminal('loading', undefined), 'Loading', 'idle', 'idle'],
  'flow-loading': [caseTerminal('flow-loading', workStatus({ flow: { availability: 'loading' } })), 'Status unknown', 'idle', 'idle'],
  'flow-unavailable': [caseTerminal('flow-unavailable', workStatus({ flow: { availability: 'unavailable' } })), 'Status unknown', 'idle', 'idle'],
  'assignment-unavailable': [caseTerminal('assignment-unavailable', workStatus({ flow: { ...running, assignment: 'unavailable' } })), 'Status unknown', 'idle', 'idle'],
  unassigned: [caseTerminal('unassigned', workStatus({ flow: { ...running, assignment: 'unassigned' }, ticket: { availability: 'none' }, activity: 'quiet' })), 'Unassigned', 'idle', 'idle'],
  'unassigned-active': [caseTerminal('unassigned-active', workStatus({ flow: { ...running, assignment: 'unassigned' }, ticket: { availability: 'none' }, activity: 'active' })), 'Unassigned', 'idle', 'idle'],
  completed: [caseTerminal('completed', workStatus({ flow: { ...running, assignment: 'completed' }, activity: 'active' })), 'Completed', 'completed', 'idle'],
  idle: [caseTerminal('idle', workStatus({ activity: 'quiet' })), 'Idle', 'idle', 'idle'],
  working: [caseTerminal('working', workStatus({ activity: 'active' })), 'Working', 'working', 'working'],
  'working-activity-unavailable': [caseTerminal('working-activity-unavailable', workStatus({ activity: 'unavailable' })), 'Working', 'working', 'working'],
} as const satisfies Record<string, readonly [ControllerTerminal, string, Status, SummaryLabel]>;

export type StatusCaseKey = keyof typeof CASES;

/**
 * Written independently of the production classifier, never derived from it, so it stays an independent oracle.
 */
export const STATUS_CASES: Readonly<Record<StatusCaseKey, StatusCase>> = Object.fromEntries(
  Object.entries(CASES).map(([key, [terminal, text, statusClass, summary]]) => [key, { terminal, text, statusClass, summary }]),
) as Record<StatusCaseKey, StatusCase>;

export function statusService(
  initial: ControllerTerminal[] = [statusTerminal()],
  options: { activation?: 'activated' | 'unavailable' | 'rejected' | ControllerApi['activateTerminal']; theme?: Theme | 'unreadable' } = {},
) {
  const listeners = new Set<(items: ControllerTerminal[]) => void>();
  const activated: string[] = [];
  const dismissed: string[] = [];
  /** Each theme the controller was asked to save, in order. */
  const savedThemes: Theme[] = [];
  let theme = options.theme;
  let current = initial;
  const publish = (items: ControllerTerminal[]): void => {
    current = items;
    listeners.forEach(listener => listener(items));
  };
  const api: ControllerApi = {
    subscribeTerminals(listener) { listeners.add(listener); listener(current); return () => { listeners.delete(listener); }; },
    async activateTerminal(id) {
      activated.push(id);
      if (typeof options.activation === 'function') return options.activation(id);
      if (options.activation === 'rejected') throw new Error('activation failed');
      return options.activation ?? 'activated';
    },
    async dismissTerminal(id) {
      dismissed.push(id);
      publish(current.filter(item => item.id !== id));
    },
    async getTheme() {
      if (theme === 'unreadable') throw new Error('theme unreadable');
      return theme ?? 'light';
    },
    async setTheme(next) {
      savedThemes.push(next);
      theme = next;
    },
  };
  return { api, activated, dismissed, publish, savedThemes };
}

export function directoryConflictFixture(): { members: StatusTerminal[]; unrelated: StatusTerminal } {
  const terminals = ['amber', 'blue', 'coral', 'denim'].map((key, index): StatusTerminal => ({
    id: `connection-${key}`,
    launchDirectory: index < 3 ? '/conflicts/shared' : '/conflicts/other-worktree',
    repositoryRoot: '/conflicts/repository',
    work: workStatus({
      flow: { availability: 'known', name: `flow-${key}`, step: `step-${key}`, assignment: 'assigned' },
      ticket: { availability: 'known', number: 271 + index, title: { availability: 'known', text: `Ticket ${key}` } },
      attention: { status: 'needs a human', reasons: [`Approve ${key}`] },
      error: { reason: `Error ${key}` },
    }),
  }));
  return { members: terminals.slice(0, 3), unrelated: terminals[3] };
}

/** The window header's and tray's counts for `distinctAttentionMix`, written independently of the production code. */
export interface AttentionMixCounts {
  total: number;
  connected: number;
  disconnected: number;
  errors: number;
  needsHuman: number;
  working: number;
}

/** One card per terminal (no shared directory) in every attention class, each class a different size, so no two counts
 *  a test compares can be swapped unnoticed (UI-STANDARDS.md §3.4 rule 4). */
export function distinctAttentionMix(): { terminals: ControllerTerminal[]; counts: AttentionMixCounts } {
  const sized = (key: string, size: number, work: WorkStatus | undefined, status?: 'disconnected') =>
    Array.from({ length: size }, (_, index) => caseTerminal(`${key}-${index + 1}`, work, status));
  const terminals = [
    ...sized('mix-disconnected', 1, undefined, 'disconnected'),
    ...sized('mix-flow-error', 3, workStatus({ error: failure })),
    ...sized('mix-needs-human', 2, workStatus({ attention: human })),
    ...sized('mix-working', 5, workStatus({ activity: 'active' })),
  ];
  return { terminals, counts: { total: 11, connected: 10, disconnected: 1, errors: 4, needsHuman: 2, working: 5 } };
}
