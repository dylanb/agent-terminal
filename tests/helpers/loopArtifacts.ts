// Deterministic fixtures for the two path families the #126 viewer change must tell apart: the §27
// in-terminal loop's working tree (`.agent-terminal/loop/`, surfaced at any depth) and the app's OWN state
// files directly under `.agent-terminal/` (kept hidden). One place single-sources those on-disk shapes so the
// #126 discovery and watch-surface integration tests can seed one canonical loop tree rather than drifting
// re-spellings when they adopt it — the same single-source discipline tests/helpers/loopCapabilities.ts
// applies to its yaml (CLAUDE.md shared-semantics). Built ahead of that discovery slice; today only its own
// self-test (loopArtifacts.test.ts) exercises it.
//
// The loop directory is derived from APP_LOOP_DIR_SEGMENTS — the SAME constant the engine writes through
// (appLoopState.ts) and the viewer will read (artifactTree.ts) — so a fixture path and the code under test
// resolve the identical directory (CLAUDE.md writer↔reader location rule). No wall-clock, randomness, or
// network: every file's bytes are fixed literals.

import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { roundReportRel, consolidatorOutputRel } from '../../src/main/appLoopState';

// The run-state file is a direct child of `loop/` (the depth-0 case). Its rel path has no exported resolver in
// appLoopState.ts (only an absolute-path one), so its leaf is spelled here; the nested reports/consolidate rel
// paths DO have exported resolvers and are derived from them below (CLAUDE.md writer↔reader-location).
const RUN_STATE_FILE = 'run-state.yaml';

// The app's own state files directly under `.agent-terminal/` — mirrors the (unexported) production paths in
// flowState.ts / todoStore.ts / monitorEventsFile.ts / auditRecorder.ts. The #126 exclusion contract is
// "directly under the app-state dir", not these exact names; they seed a realistic instance of it.
const FLOW_STATE_FILE = 'flow-state.yaml';
const TODOS_FILE = 'todos.json';
const MONITOR_EVENTS_FILE = 'monitor-events.json';
const AUDIT_POINTER_FILE = 'audit-pointer.yaml';

/** POSIX repo-relative path of the loop working tree — `.agent-terminal/loop`. Derived from the engine's own
 *  segments so the fixture and the discovery code under test resolve the identical directory. */
export const LOOP_DIR_REL = APP_LOOP_DIR_SEGMENTS.join('/');

/** POSIX repo-relative path of the app-state root — `.agent-terminal`. The loop tree lives UNDER it, so a
 *  seeded loop file is itself app-state that the #126 filter drops and the `...loop` re-add restores. */
export const APP_STATE_DIR_REL = APP_LOOP_DIR_SEGMENTS[0];

/** Build the on-disk absolute path for repo-relative POSIX `segments`, honouring the host path separator. */
function abs(repoDir: string, segments: string[]): string {
  return join(repoDir, ...segments);
}

/** Write `contents` at repo-relative POSIX `segments` under `repoDir`, creating parents, and return the
 *  POSIX relPath — the same `/`-keyed form discovery emits, so tests assert against the fixture's own output
 *  rather than re-spelled literals. */
function seedFile(repoDir: string, segments: string[], contents: string): string {
  const target = abs(repoDir, segments);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, contents);
  return segments.join('/');
}

/** POSIX repo-relative paths of the loop files a run leaves under `.agent-terminal/loop/`. `runState` is the
 *  depth-0 child of `loop/`; `plan`/`report`/`consolidate` are nested one level down — the "at any depth"
 *  cases #126 must surface. `all` is the four together for order-independent assertions. */
export interface LoopArtifactPaths {
  runState: string;
  plan: string;
  report: string;
  consolidate: string;
  all: string[];
}

/** Populate `<repoDir>/.agent-terminal/loop/` with a run's real shape: a depth-0 `run-state.yaml` directly
 *  under `loop/` plus files nested in `artifacts/`, `reports/`, `consolidate/`. Each markdown body carries a
 *  distinct H1 so a test can prove the right file opened in the viewer. Returns the POSIX relPaths written. */
export function seedLoopArtifacts(repoDir: string): LoopArtifactPaths {
  const loop = [...APP_LOOP_DIR_SEGMENTS];
  const runState = seedFile(
    repoDir,
    [...loop, RUN_STATE_FILE],
    'schema_version: 1\nloop: work-loop\nstep: work\nturn_key: work\nstatus: working\n',
  );
  const plan = seedFile(repoDir, [...loop, ARTIFACTS_SUBDIR, 'plan.md'], '# Loop plan\n\nThe sliced plan for this run.\n');
  const report = seedFile(repoDir, roundReportRel(1).split('/'), '# Round 1 report\n\nWhat round 1 changed.\n');
  const consolidate = seedFile(repoDir, consolidatorOutputRel(1).split('/'), '# Round 1 consolidation\n\nConverged findings.\n');
  return { runState, plan, report, consolidate, all: [runState, plan, report, consolidate] };
}

/** POSIX repo-relative paths of the app's own state files seeded directly under `.agent-terminal/`. */
export interface AppStateFilePaths {
  flowState: string;
  todos: string;
  monitorEvents: string;
  auditPointer: string;
  all: string[];
}

/** Seed the four app-state files directly under `<repoDir>/.agent-terminal/` — the siblings of the loop tree
 *  that #126 must keep out of the viewer. Returns the POSIX relPaths written. */
export function seedAppStateFiles(repoDir: string): AppStateFilePaths {
  const root = [APP_STATE_DIR_REL];
  const flowState = seedFile(repoDir, [...root, FLOW_STATE_FILE], 'schema_version: 1\nstatus: idle\n');
  const todos = seedFile(repoDir, [...root, TODOS_FILE], '[]\n');
  const monitorEvents = seedFile(repoDir, [...root, MONITOR_EVENTS_FILE], '[]\n');
  const auditPointer = seedFile(repoDir, [...root, AUDIT_POINTER_FILE], 'schema_version: 1\n');
  return { flowState, todos, monitorEvents, auditPointer, all: [flowState, todos, monitorEvents, auditPointer] };
}

/** True where this platform creates symlinks unprivileged — macOS/Linux (the only platforms the suite runs);
 *  false on Windows without developer mode. The symlink planters run only under this gate, so they fail loud
 *  instead of swallowing — a swallow would report a real planter regression as "no symlink support". */
export const CAN_SYMLINK = process.platform !== 'win32';

/** Plant the loop LEAF (`.agent-terminal/loop`) as a symlink to `target` (an out-of-repo dir) — the CWE-59
 *  case where the final path segment IS the link. The `.agent-terminal` parent is created as a real dir first.
 *  Call only under CAN_SYMLINK; a symlink failure throws rather than being masked. */
export function plantLoopLeafSymlink(repoDir: string, target: string): void {
  mkdirSync(abs(repoDir, [APP_STATE_DIR_REL]), { recursive: true });
  symlinkSync(target, abs(repoDir, [...APP_LOOP_DIR_SEGMENTS]));
}

/** Plant the app-state PARENT (`.agent-terminal`) as a symlink to `target` — which should itself contain a
 *  real `loop/`. This is the component a leaf-only lstat check misses: lstat on `.agent-terminal/loop` resolves
 *  the intermediate `.agent-terminal` symlink, so only whole-path resolution catches it (CWE-59). Call only
 *  under CAN_SYMLINK; a symlink failure throws rather than being masked. */
export function plantAppStateParentSymlink(repoDir: string, target: string): void {
  symlinkSync(target, abs(repoDir, [APP_STATE_DIR_REL]));
}
