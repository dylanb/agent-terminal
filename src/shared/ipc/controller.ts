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
  dismissLoopMessage: {
    name: 'controller:dismissLoopMessage',
    does: 'The controller window asks a live terminal to clear the loop message its card shows, and a replaced message or unknown terminal does nothing.',
  },
  getTheme: {
    name: 'controller:getTheme',
    does: 'The controller window reads its own saved theme, which is light when nothing usable is saved.',
  },
  setTheme: {
    name: 'controller:setTheme',
    does: "The controller window saves its own theme choice, apart from agent-terminal's settings.",
  },
  getAlwaysOnTop: {
    name: 'controller:getAlwaysOnTop',
    does: 'The controller window reads whether it is kept above other windows, which is on when main refuses the request.',
  },
  setAlwaysOnTop: {
    name: 'controller:setAlwaysOnTop',
    does: 'The controller window asks to be kept above other windows or not, and learns the value main holds afterwards.',
  },
  alwaysOnTop: {
    name: 'controller:alwaysOnTop',
    does: 'Main tells the controller window whether it is kept above other windows each time that changes, from the window or the tray.',
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
  /** Absent when either peer's minor predates loop messages. */
  loopMessage?: ControllerLoopMessage | null;
};

/** The latest loop-mechanics failure or benign no-op the terminal reported, until the operator dismisses or a newer one replaces it. */
export interface ControllerLoopMessage { id: string; kind: 'error' | 'notice'; reason: string }

export interface ControllerTerminal {
  work?: ControllerWorkStatus;
  status?: 'connected' | 'disconnected';
  id: string;
  launchDirectory: string;
  repositoryRoot: string | null;
}

export interface ControllerApi {
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  activateTerminal(id: string): Promise<'activated' | 'unavailable'>;
  dismissTerminal(id: string): Promise<void>;
  dismissLoopMessage(terminalId: string, messageId: string): Promise<void>;
  getTheme(): Promise<Theme>;
  setTheme(theme: Theme): Promise<void>;
  getAlwaysOnTop(): Promise<boolean>;
  setAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean>;
  onAlwaysOnTopChanged(listener: (alwaysOnTop: boolean) => void): () => void;
}

export const CONTROLLER_WINDOW_ARGUMENT = '--agent-terminal-controller-window';

export interface ControllerSnapshot { sessionId: SessionId; terminals: ControllerTerminal[] }
export interface ControllerActivation { sessionId: SessionId; id: string }
export interface ControllerLoopMessageDismissal { sessionId: SessionId; terminalId: string; messageId: string }
export interface ControllerThemeRequest { sessionId: SessionId }
export interface ControllerThemeChoice { sessionId: SessionId; theme: Theme }
export interface ControllerAlwaysOnTopRequest { sessionId: SessionId }
export interface ControllerAlwaysOnTopChoice { sessionId: SessionId; alwaysOnTop: boolean }

export interface ControllerVersionRange { min: number; max: number }
export interface ControllerIncompatibility {
  update: 'controller' | 'terminal';
  terminalVersion: number;
  controllerVersions: ControllerVersionRange;
}

export const CONTROLLER_DEFAULT_THEME: Theme = 'light';
export const CONTROLLER_DEFAULT_ALWAYS_ON_TOP = true;
