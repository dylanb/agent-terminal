import { CONTROLLER_DEFAULT_ALWAYS_ON_TOP, type ControllerApi, type ControllerTerminal, type ControllerWorkStatus, type Theme } from '../../src/shared/ipc';

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

export const STATUS_CLASSES = ['error', 'needs-human', 'working', 'completed', 'idle'] as const;
export type Status = (typeof STATUS_CLASSES)[number];

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
const loopError = { id: 'loop-1', kind: 'error', reason: 'the turn stalled' } as const;
const loopNotice = { id: 'loop-2', kind: 'notice', reason: 'nothing to commit' } as const;

const CASES = {
  disconnected: [caseTerminal('disconnected', undefined, 'disconnected'), 'Disconnected', 'error', 'errors'],
  'disconnected-with-error': [caseTerminal('disconnected-with-error', workStatus({ error: failure, attention: human, activity: 'active' }), 'disconnected'), 'Disconnected', 'error', 'errors'],
  'flow-error': [caseTerminal('flow-error', workStatus({ error: failure, activity: 'quiet' })), 'Flow error · Idle', 'error', 'errors'],
  'flow-error-working': [caseTerminal('flow-error-working', workStatus({ error: failure, activity: 'active' })), 'Flow error · Working', 'working', 'working'],
  'flow-error-activity-unavailable': [caseTerminal('flow-error-activity-unavailable', workStatus({ error: failure, activity: 'unavailable' })), 'Flow error · Activity unavailable', 'error', 'errors'],
  'malformed-flow-error-working': [caseTerminal('malformed-flow-error-working', workStatus({ flow: { availability: 'unavailable' }, error: failure, activity: 'active' })), 'Flow error · Working', 'working', 'working'],
  'flow-error-and-human': [caseTerminal('flow-error-and-human', workStatus({ error: failure, attention: human, activity: 'quiet' })), 'Flow error · Needs a human · Idle', 'error', 'errors'],
  'flow-error-and-human-working': [caseTerminal('flow-error-and-human-working', workStatus({ error: failure, attention: human, activity: 'active' })), 'Flow error · Needs a human · Working', 'working', 'working'],
  'flow-error-and-human-activity-unavailable': [caseTerminal('flow-error-and-human-activity-unavailable', workStatus({ error: failure, attention: human, activity: 'unavailable' })), 'Flow error · Needs a human · Activity unavailable', 'error', 'errors'],
  'loop-error': [caseTerminal('loop-error', workStatus({ loopMessage: loopError, activity: 'quiet' })), 'Loop error · Idle', 'error', 'errors'],
  'loop-error-working': [caseTerminal('loop-error-working', workStatus({ loopMessage: loopError, activity: 'active' })), 'Loop error · Working', 'working', 'working'],
  'flow-and-loop-error': [caseTerminal('flow-and-loop-error', workStatus({ error: failure, loopMessage: loopError, attention: human, activity: 'quiet' })), 'Flow error · Loop error · Needs a human · Idle', 'error', 'errors'],
  'loop-notice': [caseTerminal('loop-notice', workStatus({ loopMessage: loopNotice, activity: 'quiet' })), 'Idle', 'idle', 'idle'],
  'loop-notice-and-human': [caseTerminal('loop-notice-and-human', workStatus({ loopMessage: loopNotice, attention: human, activity: 'quiet' })), 'Needs a human · Idle', 'needs-human', 'need a human'],
  'needs-human': [caseTerminal('needs-human', workStatus({ attention: human, activity: 'quiet' })), 'Needs a human · Idle', 'needs-human', 'need a human'],
  'needs-human-working': [caseTerminal('needs-human-working', workStatus({ attention: human, activity: 'active' })), 'Needs a human · Working', 'working', 'working'],
  'needs-human-activity-unavailable': [caseTerminal('needs-human-activity-unavailable', workStatus({ attention: human, activity: 'unavailable' })), 'Needs a human · Activity unavailable', 'needs-human', 'need a human'],
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
  'activity-unavailable': [caseTerminal('activity-unavailable', workStatus({ activity: 'unavailable' })), 'Activity unavailable', 'idle', 'idle'],
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
  options: {
    activation?: 'activated' | 'unavailable' | 'rejected' | ControllerApi['activateTerminal'];
    theme?: Theme | 'unreadable';
    alwaysOnTop?: boolean | 'unreadable';
    /** How main answers a request to change always-on-top: it applies it, refuses it (replying its unchanged value),
     *  or the request rejects. */
    alwaysOnTopReply?: 'applied' | 'refused' | 'rejected';
  } = {},
) {
  const listeners = new Set<(items: ControllerTerminal[]) => void>();
  const activated: string[] = [];
  const dismissed: string[] = [];
  /** Each [terminal id, loop message id] the window asked to dismiss, in order. */
  const loopMessageDismissals: [string, string][] = [];
  /** Each theme the controller was asked to save, in order. */
  const savedThemes: Theme[] = [];
  let theme = options.theme;
  /** Each always-on-top value the controller was asked to set, in order. */
  const requestedAlwaysOnTop: boolean[] = [];
  let alwaysOnTop = options.alwaysOnTop;
  const alwaysOnTopListeners = new Set<(alwaysOnTop: boolean) => void>();
  /** Main changes always-on-top from elsewhere (the tray) and tells the window. */
  const pushAlwaysOnTop = (next: boolean): void => {
    alwaysOnTop = next;
    alwaysOnTopListeners.forEach(listener => listener(next));
  };
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
    async clearHistory() { return 'unavailable'; },
    async dismissTerminal(id) {
      dismissed.push(id);
      publish(current.filter(item => item.id !== id));
    },
    async dismissLoopMessage(terminalId, messageId) {
      loopMessageDismissals.push([terminalId, messageId]);
      publish(current.map(item => item.id === terminalId && item.work?.loopMessage?.id === messageId ? { ...item, work: { ...item.work, loopMessage: null } } : item));
    },
    async getTheme() {
      if (theme === 'unreadable') throw new Error('theme unreadable');
      return theme ?? 'light';
    },
    async setTheme(next) {
      savedThemes.push(next);
      theme = next;
    },
    async getAlwaysOnTop() {
      if (alwaysOnTop === 'unreadable') throw new Error('always-on-top unreadable');
      return alwaysOnTop ?? CONTROLLER_DEFAULT_ALWAYS_ON_TOP;
    },
    async setAlwaysOnTop(next) {
      requestedAlwaysOnTop.push(next);
      if (options.alwaysOnTopReply === 'rejected') throw new Error('always-on-top not set');
      if (options.alwaysOnTopReply !== 'refused') alwaysOnTop = next;
      return alwaysOnTop === 'unreadable' || alwaysOnTop === undefined ? CONTROLLER_DEFAULT_ALWAYS_ON_TOP : alwaysOnTop;
    },
    onAlwaysOnTopChanged(listener) {
      alwaysOnTopListeners.add(listener);
      return () => { alwaysOnTopListeners.delete(listener); };
    },
  };
  /** Whether the window still listens for always-on-top pushes. */
  const followingAlwaysOnTop = (): boolean => alwaysOnTopListeners.size > 0;
  return { api, activated, dismissed, loopMessageDismissals, publish, savedThemes, requestedAlwaysOnTop, pushAlwaysOnTop, followingAlwaysOnTop };
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
    ...sized('mix-flow-error', 3, workStatus({ error: failure, activity: 'quiet' })),
    ...sized('mix-needs-human', 2, workStatus({ attention: human, activity: 'quiet' })),
    ...sized('mix-working', 5, workStatus({ activity: 'active' })),
  ];
  return { terminals, counts: { total: 11, connected: 10, disconnected: 1, errors: 4, needsHuman: 2, working: 5 } };
}
