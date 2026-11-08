import type { WaitingValue } from '../shared/waiting';

export type WaitingPlatform = 'darwin' | 'linux';

/** The platforms whose `ps` the rule reads; null elsewhere, where no terminal reads Waiting. */
export function waitingPlatform(platform: string): WaitingPlatform | null {
  return platform === 'darwin' || platform === 'linux' ? platform : null;
}

export interface ProcessTableReading {
  /** The terminal's shell, whose foreground program is the agent. */
  readonly shellPid: number;
  readonly platform: WaitingPlatform;
  /** Program names the operator's helper file lists, beside the built-in ones. */
  readonly helpers: readonly string[];
}

/** Helpers a harness starts outside its own process group that keep the terminal, named as their executables. */
const BUILT_IN_HELPERS: readonly string[] = ['codex-code-mode-host'];

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh']);

const PROGRAM_NAME_LIMIT: Readonly<Record<WaitingPlatform, number>> = { darwin: 16, linux: 15 };

/** procps truncates elapsed time and macOS can round it up, so a reading of 2 s is a real age over 1 s on both. */
const COMMAND_MIN_ELAPSED_S = 2;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** The foreground group of the process's controlling terminal; zero or less when it has none. Every process on
   *  the agent's terminal reads the agent's group here while the agent is in the foreground. */
  readonly tpgid: number;
  /** Whole seconds since the process started, as the OS reports it. */
  readonly elapsedS: number;
  readonly program: string;
}

/** Earliest-started first; the lower pid breaks a tie in whole-second elapsed readings. */
const byStart = (a: ProcessRow, b: ProcessRow): number => b.elapsedS - a.elapsedS || a.pid - b.pid;

/**
 * What a Waiting terminal shows, from the host's processes: null when the agent in the shell's
 * foreground is running no command. A command is a process the agent — its group's leader — started in a group of
 * its own and off the agent's terminal (a new session, or a terminal of its own), that is over a second old and is
 * no helper. What a helper in the agent's group starts belongs to that helper.
 */
export function waitingInTable(rows: readonly ProcessRow[], reading: ProcessTableReading): WaitingValue | null {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const shell = byPid.get(reading.shellPid);
  if (!shell || shell.tpgid <= 0 || shell.tpgid === shell.pgid) return null;
  const agentGroup = shell.tpgid;
  const limit = PROGRAM_NAME_LIMIT[reading.platform];
  const helpers = new Set([...BUILT_IN_HELPERS, ...reading.helpers].map((name) => name.slice(0, limit)));
  const children = (parent: ProcessRow): ProcessRow[] => rows.filter((row) => row.ppid === parent.pid).sort(byStart);
  const labelFrom = (candidate: ProcessRow): ProcessRow => {
    if (!SHELLS.has(candidate.program)) return candidate;
    return children(candidate)[0] ?? candidate;
  };
  const commands = rows
    .filter((row) => row.ppid === agentGroup && row.pgid !== agentGroup && row.tpgid !== agentGroup)
    .filter((candidate) => candidate.elapsedS >= COMMAND_MIN_ELAPSED_S)
    .map((candidate) => ({ candidate, label: labelFrom(candidate) }))
    .filter(({ candidate, label }) => label.program.length > 0 && ![candidate, label].some((p) => helpers.has(p.program)))
    .sort((a, b) => byStart(a.candidate, b.candidate));
  if (commands.length === 0) return null;
  return { program: commands[0].label.program, others: commands.length - 1 };
}
