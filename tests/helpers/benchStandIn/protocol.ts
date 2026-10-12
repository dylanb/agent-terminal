// The stand-in agent's state directory: the behaviour file a test writes and the logs the stand-in appends.
// The test harness (harness.ts) and the stand-in executable (standIn.ts) both go through this module, so the
// writer and the reader of each file cannot drift (CLAUDE.md shared-semantics).

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAND_IN_STATE_ENV = 'BENCH_STAND_IN_STATE';

export const STAND_IN_VERSION = '0.0.0-stand-in (Claude Code)';

export type RoundFile = 'report' | 'consolidator';

export interface StandInWrite {
  to: { rel: string } | { round: RoundFile };
  content: string;
}

export interface StandInEvent {
  waitFor?: string;
  text?: string;
}

export interface StandInUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

/** One turn's scripted behaviour. Every field is optional: an absent field takes the default a cooperative
 *  agent would show — the default product for the prompt's phase, one activity event, the done file, exit 0. */
export interface StandInTurn {
  writes?: StandInWrite[];
  defaultProduct?: boolean;
  shell?: string[];
  events?: StandInEvent[];
  holdBeforeDone?: string;
  done?: boolean;
  holdBeforeExit?: string;
  exit?: 'exit' | 'never';
  exitCode?: number;
}

export interface StandInJudge {
  replyById?: Record<string, string>;
  reply?: string;
  shell?: string[];
  exitCode?: number;
}

export interface StandInScript {
  turns?: Record<string, StandInTurn[]>;
  replies?: StandInTurn[];
  judge?: StandInJudge;
}

/** `byRun` keys are the 1-based run index: the order in which the stand-in first saw each workspace. */
export interface StandInBehaviour extends StandInScript {
  usage?: StandInUsage;
  byRun?: Record<string, StandInScript>;
}

export const DEFAULT_USAGE: StandInUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_creation_input_tokens: 10,
  cache_read_input_tokens: 20,
};

export interface LaunchEntry {
  pid: number;
  mode: 'agent' | 'judge' | 'version' | 'usage-error';
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  run: number | null;
}

export interface PromptEntry {
  run: number;
  sessionId: string;
  key: string;
  occurrence: number;
  prompt: string;
}

export interface ReadEntry {
  run: number;
  key: string;
  path: string;
  content: string | null;
}

export interface ShellEntry {
  run: number;
  key: string;
  command: string;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ExitEntry {
  pid: number;
  run: number | null;
  key: string | null;
  code: number;
}

export interface JudgeEntry {
  run: number;
  prompt: string;
  reply: string;
}

const BEHAVIOUR = 'behaviour.json';
const LOGS = {
  launches: 'launches.jsonl',
  prompts: 'prompts.jsonl',
  reads: 'reads.jsonl',
  shell: 'shell.jsonl',
  exits: 'exits.jsonl',
  judge: 'judge.jsonl',
} as const;
type LogName = keyof typeof LOGS;
const WORKSPACES = 'workspaces.json';
const OCCURRENCES_DIR = 'occurrences';
const GATES_DIR = 'gates';
const WAITING_DIR = 'waiting';
const PIDS_DIR = 'pids';

export function writeBehaviour(stateDir: string, behaviour: StandInBehaviour): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, BEHAVIOUR), JSON.stringify(behaviour, null, 2));
}

export function readBehaviour(stateDir: string): StandInBehaviour {
  const file = join(stateDir, BEHAVIOUR);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StandInBehaviour) : {};
}

export function appendLog(stateDir: string, log: LogName, entry: unknown): void {
  appendFileSync(join(stateDir, LOGS[log]), `${JSON.stringify(entry)}\n`);
}

function readLog<T>(stateDir: string, log: LogName): T[] {
  const file = join(stateDir, LOGS[log]);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

export const readLaunches = (stateDir: string): LaunchEntry[] => readLog(stateDir, 'launches');
export const readPrompts = (stateDir: string): PromptEntry[] => readLog(stateDir, 'prompts');
export const readReads = (stateDir: string): ReadEntry[] => readLog(stateDir, 'reads');
export const readShell = (stateDir: string): ShellEntry[] => readLog(stateDir, 'shell');
export const readExits = (stateDir: string): ExitEntry[] => readLog(stateDir, 'exits');
export const readJudgeCalls = (stateDir: string): JudgeEntry[] => readLog(stateDir, 'judge');

function seenWorkspaces(stateDir: string): string[] {
  const file = join(stateDir, WORKSPACES);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [];
}

/** The 1-based run index of the agent workspace `workspace` — assigned the first time the stand-in sees it, so
 *  the Nth sandbox a series creates is run N. Runs are sequential, so no two processes assign at once. */
export function runIndexFor(stateDir: string, workspace: string): number {
  const file = join(stateDir, WORKSPACES);
  const seen = seenWorkspaces(stateDir);
  const at = seen.indexOf(workspace);
  if (at >= 0) return at + 1;
  seen.push(workspace);
  writeFileSync(file, JSON.stringify(seen));
  return seen.length;
}

/** The run the latest agent workspace belongs to: the judge scores a run from its own directory, which is not
 *  that run's workspace. */
export function currentRunIndex(stateDir: string): number {
  return Math.max(1, seenWorkspaces(stateDir).length);
}

/** Count one more sighting of `key` in run `run`; returns the 1-based occurrence. */
export function nextOccurrence(stateDir: string, run: number, key: string): number {
  const dir = join(stateDir, OCCURRENCES_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${run}.json`);
  const counts: Record<string, number> = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>) : {};
  counts[key] = (counts[key] ?? 0) + 1;
  writeFileSync(file, JSON.stringify(counts));
  return counts[key];
}

export function releaseGate(stateDir: string, name: string): void {
  mkdirSync(join(stateDir, GATES_DIR), { recursive: true });
  writeFileSync(join(stateDir, GATES_DIR, name), '');
}

export function gateReleased(stateDir: string, name: string): boolean {
  return existsSync(join(stateDir, GATES_DIR, name));
}

export function markWaiting(stateDir: string, name: string): void {
  mkdirSync(join(stateDir, WAITING_DIR), { recursive: true });
  writeFileSync(join(stateDir, WAITING_DIR, name), '');
}

export function isWaiting(stateDir: string, name: string): boolean {
  return existsSync(join(stateDir, WAITING_DIR, name));
}

export function recordPid(stateDir: string, pid: number): void {
  mkdirSync(join(stateDir, PIDS_DIR), { recursive: true });
  writeFileSync(join(stateDir, PIDS_DIR, String(pid)), '');
}

export function recordedPids(stateDir: string): number[] {
  const dir = join(stateDir, PIDS_DIR);
  return existsSync(dir) ? readdirSync(dir).map(Number) : [];
}

/** The script for run `run`: its `byRun` entry's fields override the top-level ones field by field. */
export function scriptForRun(behaviour: StandInBehaviour, run: number): StandInScript {
  const over = behaviour.byRun?.[String(run)] ?? {};
  return {
    turns: { ...(behaviour.turns ?? {}), ...(over.turns ?? {}) },
    replies: over.replies ?? behaviour.replies,
    judge: over.judge ?? behaviour.judge,
  };
}

/** The nth scripted entry, the last one repeating once the list runs out; none when nothing is scripted. */
export function nthEntry<T>(list: T[] | undefined, occurrence: number): T | undefined {
  if (list === undefined || list.length === 0) return undefined;
  return list[Math.min(occurrence, list.length) - 1];
}
