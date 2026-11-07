// Process tables for the Waiting detection tests, in the one `ps` output format both sources share: the captures
// `scripts/capture-process-table.mjs` takes from real harness runs (tests/fixtures/process-tables/), and the
// hand-built tables `processTree` renders. Expected results are written by hand: this file never imports the code
// it checks (EXPECTED_RESULTS_FIXTURES in eslint.config.mjs).

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** The argv every table here was produced with; the capture script records the argv it ran, and a capture taken
 *  with any other is rejected at load. */
export const PS_ARGS: readonly string[] = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,etime=,ucomm='];

export type TablePlatform = 'darwin' | 'linux';

/** The tpgid `ps` prints for a process with no controlling terminal. */
export const NO_TERMINAL: Readonly<Record<TablePlatform, number>> = { darwin: 0, linux: -1 };

/** The longest program name each OS reports; a longer executable name is cut to it. */
export const PROGRAM_NAME_LIMIT: Readonly<Record<TablePlatform, number>> = { darwin: 16, linux: 15 };

/** What the terminal should show for a table with only the built-in helper names: no Waiting, or the program label
 *  of the earliest-started command plus the count of the other commands. */
export type WaitingExpectation = null | { readonly program: string; readonly others: number };

export interface ProcessTableFixture {
  readonly name: string;
  readonly platform: TablePlatform;
  readonly shellPid: number;
  /** What was running when the table was captured, in the capturer's words. */
  readonly note: string;
  readonly stdout: string;
  readonly expected: WaitingExpectation;
}

export const PROCESS_TABLE_DIR = resolve(__dirname, '../fixtures/process-tables');

function fail(file: string, why: string): never {
  throw new Error(`${file}: ${why} (see scripts/capture-process-table.mjs)`);
}

function expectation(file: string, raw: unknown): WaitingExpectation {
  if (typeof raw !== 'object' || raw === null || !('waiting' in raw)) fail(file, 'expected must be { "waiting": … }, written by hand');
  const waiting = (raw as { waiting: unknown }).waiting;
  if (waiting === null) return null;
  const { program, others } = (waiting ?? {}) as { program?: unknown; others?: unknown };
  if (typeof program !== 'string' || program.length === 0) fail(file, 'expected.waiting.program must be a non-empty string');
  if (typeof others !== 'number' || !Number.isInteger(others) || others < 0) fail(file, 'expected.waiting.others must be a non-negative integer');
  return { program, others };
}

function parseFixture(file: string): ProcessTableFixture {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const { platform, psArgs, shellPid, note, rows } = raw;
  if (platform !== 'darwin' && platform !== 'linux') fail(file, 'platform must be "darwin" or "linux"');
  if (JSON.stringify(psArgs) !== JSON.stringify(PS_ARGS)) fail(file, `captured with ps ${JSON.stringify(psArgs)}, not ${JSON.stringify(PS_ARGS)}; re-capture it`);
  if (typeof shellPid !== 'number' || !Number.isInteger(shellPid) || shellPid <= 0) fail(file, 'shellPid must be a positive integer');
  if (typeof note !== 'string' || note.trim().length === 0) fail(file, 'note must say what was running');
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every((r) => typeof r === 'string')) fail(file, 'rows must be the captured ps lines');
  if (!rows.some((r) => r.trim().split(/\s+/)[0] === String(shellPid))) fail(file, `no row for shell pid ${shellPid}`);
  return { name: basename(file, '.json'), platform, shellPid, note, stdout: `${rows.join('\n')}\n`, expected: expectation(file, raw.expected) };
}

/** Every captured table, each checked for a hand-written expected result. Throws when there are none, so a test
 *  looping over them can never pass by running nothing. */
export function loadProcessTableFixtures(dir = PROCESS_TABLE_DIR): ProcessTableFixture[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch (e) {
    throw new Error(`no process-table captures at ${dir}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (files.length === 0) throw new Error(`no process-table captures in ${dir}; take them with scripts/capture-process-table.mjs`);
  return files.map((f) => parseFixture(join(dir, f)));
}

export interface TreeProcess {
  readonly pid: number;
  readonly pgid: number;
}

export interface SpawnOptions {
  /** `own` starts a new process group led by this process; the default stays in the parent's group. */
  readonly group?: 'parent' | 'own';
  /** The elapsed time exactly as `ps` prints it (`00:01`, `1-02:03:04`). By default each process is older than
   *  every process spawned after it, by whole seconds, and minutes old. */
  readonly etime?: string;
  /** false: the process has no controlling terminal (a new session), so `ps` prints its tpgid as `NO_TERMINAL`
   *  for the platform. The default follows the parent. */
  readonly tty?: boolean;
}

export interface ProcessTree {
  /** The terminal's shell: its own group leader, with the terminal's foreground at its prompt until `foreground`. */
  readonly shell: TreeProcess;
  /** Adds `program` as a child of `parent`; the name is cut to the platform's limit as the OS would. */
  spawn(parent: TreeProcess, program: string, options?: SpawnOptions): TreeProcess;
  /** Hands the terminal's foreground to `leader`'s process group, as the shell does when it runs a program. */
  foreground(leader: TreeProcess): void;
  /** The table as `ps ${PS_ARGS}` prints it. */
  stdout(): string;
}

interface Row extends TreeProcess {
  readonly ppid: number;
  readonly tty: boolean;
  readonly etime: string;
  readonly program: string;
}

const FIRST_PID = 4100;
const PID_STEP = 23;
const SHELL_SECONDS = 7200;
const FIRST_SPAWN_SECONDS = 900;

export function formatEtime(seconds: number): string {
  if (!Number.isInteger(seconds) || seconds < 0) throw new RangeError(`elapsed seconds must be a non-negative integer; got ${seconds}`);
  const two = (n: number): string => String(n).padStart(2, '0');
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const clock = `${two(Math.floor((seconds % 3600) / 60))}:${two(seconds % 60)}`;
  if (days > 0) return `${days}-${two(hours)}:${clock}`;
  return hours > 0 ? `${two(hours)}:${clock}` : clock;
}

/** A hand-built process table. Every process gets a distinct pid, and every group a distinct id, so no two
 *  processes a test tells apart can be swapped. */
export function processTree({ platform, shell = 'zsh' }: { platform: TablePlatform; shell?: string }): ProcessTree {
  const rows: Row[] = [];
  const named = (program: string): string => {
    if (program.length > 0 && program.trim() !== program) throw new RangeError(`program name ${JSON.stringify(program)} has edge whitespace ps would not print`);
    return program.slice(0, PROGRAM_NAME_LIMIT[platform]);
  };
  const shellPid = FIRST_PID;
  rows.push({ pid: shellPid, ppid: shellPid - 1, pgid: shellPid, tty: true, etime: formatEtime(SHELL_SECONDS), program: named(shell) });
  let foregroundGroup = shellPid;
  const find = (p: TreeProcess): Row => {
    const row = rows.find((r) => r.pid === p.pid);
    if (!row) throw new Error(`pid ${p.pid} is not in this tree`);
    return row;
  };
  return {
    shell: { pid: shellPid, pgid: shellPid },
    spawn(parent, program, options = {}) {
      const up = find(parent);
      const pid = FIRST_PID + rows.length * PID_STEP;
      const etime = options.etime ?? formatEtime(FIRST_SPAWN_SECONDS - rows.length);
      const row: Row = { pid, ppid: up.pid, pgid: options.group === 'own' ? pid : up.pgid, tty: options.tty ?? up.tty, etime, program: named(program) };
      rows.push(row);
      return { pid: row.pid, pgid: row.pgid };
    },
    foreground(leader) {
      foregroundGroup = find(leader).pgid;
    },
    stdout() {
      const col = (n: number): string => String(n).padStart(5);
      return rows.map((r) => `${col(r.pid)} ${col(r.ppid)} ${col(r.pgid)} ${col(r.tty ? foregroundGroup : NO_TERMINAL[platform])} ${r.etime.padStart(11)} ${r.program}`).join('\n') + '\n';
    },
  };
}
