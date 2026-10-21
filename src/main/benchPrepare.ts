import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchGithub } from './benchGithub';
import type { BenchAccepted } from './benchRefusals';
import { createActiveFlowGate } from './activeFlowGate';
import { runAppCommand } from './appCommand';
import { recordBaselineCommit } from './appLoopState';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopPaths';
import { readConfinedTree } from './benchTree';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { errMsg } from './errno';
import { FLOW_DEF_FILE, catalogEntryDefFile } from './flow';
import { catalogTierJail } from './flowCatalog';
import { flowHomeDir } from './flowHome';
import { createFlowStateStore } from './flowState';
import { flowHomeRels } from './installExamples';
import { createWorktreeLock, worktreeLockRoot } from './worktreeLock';
import { BENCH_FIXTURE_ARTIFACTS } from '../shared/benchFixture';
import { BENCH_LAUNCH_SCHEMA, type BenchLaunch, type BenchSpan } from '../shared/benchLaunch';

/** The repo-tier catalog id a run's working folder holds the validated flow under. */
export const BENCH_FLOW_ID = 'bench-run-flow';

const SPAN_END_FILE = 'span-end.json';

/** `prepare-failed` is any other git or file-system failure. */
export type BenchPrepareFailure = 'restore-escapes' | 'pr-acting-gate' | 'issue-copy-failed' | 'prepare-failed';

export interface BenchPrepareRequest {
  invokingRepo: string;
  appHome: string;
  fixtureDir: string;
  accepted: BenchAccepted;
  span: BenchSpan;
  /** This command's folder under the app home, as a real path. */
  stampDir: string;
  stamp: string;
  run: number;
  github: BenchGithub;
}

export type BenchPrepared =
  | { ok: true; runFolder: string; launch: BenchLaunch; branch: string; issueCopy: number }
  /** `runFolder` is null when the run's folder could not be made. */
  | { ok: false; code: BenchPrepareFailure; runFolder: string | null; reason: string };

/** Where every command's folder lives: `<app home>/.agent-terminal/bench/`. */
export function benchRootDir(appHome: string): string {
  return path.join(flowHomeDir(appHome), 'bench');
}

class PrepareError extends Error {
  constructor(
    readonly code: BenchPrepareFailure,
    reason: string,
  ) {
    super(reason);
  }
}

const confinedOk = (jail: string, target: string): boolean => {
  const res = confinedRealPathResult(jail, target);
  return res.ok && res.path === path.resolve(target);
};

/** `jail` as a symlink-free directory inside the worktree, or a restore refusal (CWE-22/59). */
function ownJail(jail: string | null, what: string): string {
  if (jail === null || !confinedOk(jail, jail)) throw new PrepareError('restore-escapes', `${what} resolves outside the working folder`);
  return jail;
}

function writeConfined(jail: string, rel: string, bytes: Buffer | string): void {
  const target = path.join(jail, rel);
  if (!confinedOk(jail, target)) throw new PrepareError('restore-escapes', `${rel} resolves outside the working folder`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function restoreArtifacts(fixtureDir: string, workingFolder: string): void {
  const source = readConfinedTree(resolveJail(fixtureDir, BENCH_FIXTURE_ARTIFACTS));
  if (!source.ok) throw new PrepareError('restore-escapes', "a fixture artifact resolves outside the fixture's folder or cannot be resolved (a dangling or unreadable link)");
  const jail = ownJail(resolveJail(workingFolder, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR), 'the loop artifacts folder');
  for (const [rel, bytes] of source.files) writeConfined(jail, rel, bytes);
}

/** The validated flow text as the working folder's repo-tier catalog entry, beside its flow home's files. */
function installFlow(accepted: BenchAccepted, workingFolder: string, appHome: string): void {
  let rels: string[] | null;
  try {
    rels = flowHomeRels(accepted.flowHome);
  } catch (e) {
    throw new PrepareError('restore-escapes', errMsg(e));
  }
  const jail = ownJail(catalogTierJail({ worktreeDir: workingFolder, globalRoot: appHome }, 'repo'), 'the flow catalog');
  const entry = path.relative(jail, path.dirname(catalogEntryDefFile(workingFolder, BENCH_FLOW_ID)));
  writeConfined(jail, path.join(entry, FLOW_DEF_FILE), accepted.flowText);
  for (const rel of rels ?? []) {
    if (rel !== FLOW_DEF_FILE) writeConfined(jail, path.join(entry, rel), readFileSync(path.join(accepted.flowHome, rel)));
  }
}

function seed(request: BenchPrepareRequest, workingFolder: string, branch: string, copy: number): void {
  const pointer = createActiveFlowGate(createWorktreeLock({ lockRoot: worktreeLockRoot(request.appHome) })).set(workingFolder, BENCH_FLOW_ID);
  if (!pointer.ok) throw new PrepareError('prepare-failed', pointer.reason);
  const { fixture, ticketInput } = request.accepted;
  createFlowStateStore(workingFolder).write({
    step: request.span.first,
    status: 'not_started',
    inputs: { ...fixture.inputs, ...(ticketInput === null ? {} : { [ticketInput]: String(copy) }) },
    repeatCounts: fixture.repeat_counts,
  });
  if (fixture.phase_baseline !== undefined) recordBaselineCommit(workingFolder, branch, fixture.phase_baseline);
}

export async function prepareBenchRun(request: BenchPrepareRequest): Promise<BenchPrepared> {
  const { stamp, run } = request;
  const runFolder = path.join(request.stampDir, `run-${run}`);
  try {
    mkdirSync(runFolder);
  } catch (e) {
    return { ok: false, code: 'prepare-failed', runFolder: null, reason: errMsg(e) };
  }
  try {
    const worktree = path.join(runFolder, `bench-${stamp}-run-${run}`);
    const branch = `bench/${stamp}/run-${run}`;
    await runAppCommand('git', ['worktree', 'add', '-q', '-b', branch, worktree, request.accepted.fixture.commit], request.invokingRepo);
    // The app's launch root and repo keys are real paths, so the launch names the worktree by its own.
    const workingFolder = realpathSync(worktree);
    restoreArtifacts(request.fixtureDir, workingFolder);
    installFlow(request.accepted, workingFolder, request.appHome);
    // The app loads the fixture commit's repository tier, which the refusal over the invoking repository did not read.
    const prActing = request.accepted.prActingIn(workingFolder);
    if (prActing === null) throw new PrepareError('prepare-failed', "a span step's loop def does not resolve in the working folder");
    if (prActing) throw new PrepareError('pr-acting-gate', "the fixture commit's loop defs put a gate acting on the pickup pull request in the span");
    let copy: number;
    try {
      copy = await request.github.copyIssue(request.accepted.fixture.issue);
    } catch (e) {
      throw new PrepareError('issue-copy-failed', errMsg(e));
    }
    try {
      seed(request, workingFolder, branch, copy);
    } catch (e) {
      throw new PrepareError(e instanceof PrepareError ? e.code : 'prepare-failed', `${errMsg(e)} (issue copy #${copy} was created)`);
    }
    return {
      ok: true,
      runFolder,
      branch,
      issueCopy: copy,
      launch: { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder, span: request.span, spanEndFile: path.join(runFolder, SPAN_END_FILE) },
    };
  } catch (e) {
    return { ok: false, code: e instanceof PrepareError ? e.code : 'prepare-failed', runFolder, reason: errMsg(e) };
  }
}
