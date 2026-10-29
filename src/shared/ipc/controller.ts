import type { ChannelSpecs, SessionId } from './session';
import type { Theme } from './settings';

export const CONTROLLER_CHANNELS = {
  subscribe: {
    name: 'controller:subscribe',
    does: 'The controller window asks for the current snapshot of live and disconnected terminals.',
  },
  terminals: {
    name: 'controller:terminals',
    does: 'Main sends the controller window the live and retained-disconnected terminals whenever registrations change.',
  },
  activate: {
    name: 'controller:activate',
    does: 'The controller window brings the live terminal with this id forward and learns whether it could.',
  },
  dismiss: {
    name: 'controller:dismiss',
    does: 'The controller window removes one disconnected terminal, and an unknown, live or replaced id does nothing.',
  },
  clearHistory: {
    name: 'controller:clearHistory',
    does: 'The controller window clears retained notifications for the observed terminal without changing its live work.',
  },
  getTheme: {
    name: 'controller:getTheme',
    does: 'The controller window reads its own saved theme, which is light when nothing usable is saved.',
  },
  setTheme: {
    name: 'controller:setTheme',
    does: "The controller window saves its own theme choice, apart from agent-terminal's settings.",
  },
} as const satisfies ChannelSpecs;

export type ControllerWorkStatus = {
  unavailableReason?: 'message-too-large';
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

export interface ControllerReceivedNotification { message: string; receivedAt: number }

export interface ControllerNotificationEntry extends ControllerReceivedNotification { count: number }

export interface ControllerTerminal {
  notificationVersion?: string;
  notifications?: ControllerNotificationEntry[];
  latestNotification?: ControllerReceivedNotification;
  work?: ControllerWorkStatus;
  status?: 'connected' | 'disconnected';
  id: string;
  launchDirectory: string;
  repositoryRoot: string | null;
}

export type ControllerClearOutcome = 'cleared' | 'stale' | 'unavailable';
export interface ControllerClearRequest { sessionId: SessionId; observed: ControllerTerminal }

export interface ControllerApi {
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  activateTerminal(id: string): Promise<'activated' | 'unavailable'>;
  dismissTerminal(id: string): Promise<void>;
  clearHistory(observed: ControllerTerminal): Promise<ControllerClearOutcome>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
}

export const CONTROLLER_WINDOW_ARGUMENT = '--agent-terminal-controller-window';

export interface ControllerSnapshot { sessionId: SessionId; terminals: ControllerTerminal[] }
export interface ControllerActivation { sessionId: SessionId; id: string }
export interface ControllerThemeRequest { sessionId: SessionId }
export interface ControllerThemeChoice { sessionId: SessionId; theme: Theme }

export interface ControllerVersionRange { min: number; max: number }
export interface ControllerIncompatibility {
  update: 'controller' | 'terminal';
  terminalVersion: number;
  controllerVersions: ControllerVersionRange;
}

export const CONTROLLER_DEFAULT_THEME: Theme = 'light';
