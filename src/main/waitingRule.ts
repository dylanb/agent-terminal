import type { WaitingValue } from '../shared/waiting';

export type WaitingPlatform = 'darwin' | 'linux';

export function waitingPlatform(platform: string): WaitingPlatform | null {
  return platform === 'darwin' || platform === 'linux' ? platform : null;
}

export interface ProcessTableReading {
  readonly shellPid: number;
  readonly platform: WaitingPlatform;
  readonly helpers: readonly string[];
}

const BUILT_IN_HELPERS: readonly string[] = ['codex-code-mode-host'];

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'tcsh', 'csh']);

const PROGRAM_NAME_LIMIT: Readonly<Record<WaitingPlatform, number>> = { darwin: 16, linux: 15 };

const COMMAND_MIN_ELAPSED_S = 2;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly tpgid: number;
  readonly elapsedS: number;
  readonly program: string;
}

const byStart = (a: ProcessRow, b: ProcessRow): number => b.elapsedS - a.elapsedS || a.pid - b.pid;

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
