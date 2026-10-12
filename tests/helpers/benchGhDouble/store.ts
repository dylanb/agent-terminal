// The `gh` test double's store: the GitHub state it serves, the record of every call it received, and the
// failures a test scripts. The double (ghDouble.ts) and the test harness (harness.ts) both go through this
// module, so the writer and the reader of each file cannot drift (CLAUDE.md shared-semantics).

import { appendFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isErrno } from '../../../src/main/errno';

export const GH_DOUBLE_STORE_ENV = 'BENCH_GH_DOUBLE_STORE';

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: string[];
  assignees: string[];
  comments: string[];
}

export interface GhPull extends GhIssue {
  base: string;
  head: string;
  headOid: string;
  isDraft: boolean;
}

export interface GhRepo {
  slug: string;
  bare: string;
  private: boolean;
  description: string;
  topics: string[];
  labels: string[];
  issues: GhIssue[];
  pulls: GhPull[];
  nextNumber: number;
}

export interface GhState {
  repos: Record<string, GhRepo>;
}

export interface GhCall {
  argv: string[];
  cwd: string;
  repo: string | null;
  credential: 'hosts' | 'env' | null;
  refused: boolean;
  hung: boolean;
  code: number;
}

export interface GhScriptRule {
  argv: string[];
  action: 'fail' | 'hang';
  stderr?: string;
  code?: number;
}

const STATE = 'state.json';
const RECORD = 'record.jsonl';
const SCRIPT = 'script.json';
const LOCK = 'lock';
const BARE_DIR = 'bare';

export function bareRepoDir(store: string, slug: string): string {
  return join(store, BARE_DIR, `${slug}.git`);
}

export function readState(store: string): GhState {
  const file = join(store, STATE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GhState) : { repos: {} };
}

export function writeState(store: string, state: GhState): void {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, STATE), JSON.stringify(state, null, 2));
}

export function appendCall(store: string, call: GhCall): void {
  appendFileSync(join(store, RECORD), `${JSON.stringify(call)}\n`);
}

export function readCalls(store: string): GhCall[] {
  const file = join(store, RECORD);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GhCall);
}

export function writeScript(store: string, rules: GhScriptRule[]): void {
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, SCRIPT), JSON.stringify(rules));
}

export function readScript(store: string): GhScriptRule[] {
  const file = join(store, SCRIPT);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as GhScriptRule[]) : [];
}

/** The scripted rule for `argv`: the first whose argv is a prefix of the call's. */
export function matchRule(rules: GhScriptRule[], argv: string[]): GhScriptRule | undefined {
  return rules.find((r) => r.argv.every((a, i) => argv[i] === a));
}

/** Run `fn` holding the store's lock, so concurrent `gh` processes never interleave a read-modify-write. A lock
 *  whose holder is gone — a `gh` killed mid-call — is taken over. */
export function withLock<T>(store: string, fn: () => T): T {
  mkdirSync(store, { recursive: true });
  const lock = join(store, LOCK);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const claim = `${lock}.${process.pid}`;
  writeFileSync(claim, String(process.pid));
  try {
    for (;;) {
      try {
        linkSync(claim, lock);
        break;
      } catch (e) {
        if (!isErrno(e, 'EEXIST')) throw e;
        if (lockHolderGone(lock)) rmSync(lock, { force: true });
        else Atomics.wait(pause, 0, 0, 5);
      }
    }
  } finally {
    rmSync(claim, { force: true });
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

function lockHolderGone(lock: string): boolean {
  let holder: number;
  try {
    holder = Number(readFileSync(lock, 'utf8'));
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
  if (!Number.isInteger(holder) || holder <= 0) return true;
  try {
    process.kill(holder, 0);
    return false;
  } catch (e) {
    return isErrno(e, 'ESRCH');
  }
}

export function newRepo(store: string, slug: string, opts: { private: boolean; description: string }): GhRepo {
  return { slug, bare: bareRepoDir(store, slug), private: opts.private, description: opts.description, topics: [], labels: [], issues: [], pulls: [], nextNumber: 1 };
}
