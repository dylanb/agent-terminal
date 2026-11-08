import type { TurnOrigin } from '../shared/turnOrigin';

/** How a Claude Code session was launched, as its command line shows: `print` for `-p`/`--print` or a piped prompt,
 *  `launchPrompt` for a prompt given on the command line. */
export interface SessionLaunch {
  print: boolean;
  launchPrompt: boolean;
}

/** The turns of the Claude Code sessions in the window's terminal, each session named by its process id. */
export interface SessionTurns {
  /** A Claude Code hook's report: `input` is what Claude Code wrote to the hook's stdin. */
  hook(session: number, input: unknown): void;
  /** Text main's injector wrote to the terminal. */
  injected(text: string): void;
  origin(session: number): Promise<TurnOrigin>;
}

export function createSessionTurns(_deps: { launchOf: (session: number) => Promise<SessionLaunch | null> }): SessionTurns {
  return { hook: () => {}, injected: () => {}, origin: async () => 'undetermined' };
}
