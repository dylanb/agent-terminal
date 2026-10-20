// #180 — `bench capture`: a working folder of a real run becomes a fixture (docs/bench.md).

import { lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchGithub } from './benchGithub';
import { parseAppGitObjectId, runAppCommand } from './appCommand';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from './appLoopPaths';
import { baselineForBranch, readBaselineCommit } from './appLoopState';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { readDirEntries } from './dirEntries';
import { isErrno } from './errno';
import { flowTypedInput } from './flow';
import { createFlowStateStore } from './flowState';
import { currentGitBranch } from './gitBranch';
import { createRunResolver } from './runResolver';
import {
  BENCH_FIXTURE_ARTIFACTS,
  BENCH_FIXTURE_MANIFEST,
  BENCH_FIXTURE_SCHEMA,
  isFixtureIssueNumber,
  serializeBenchFixture,
  type BenchFixture,
} from '../shared/benchFixture';
import { readWholeNumber } from '../shared/flowStateValues';

export type BenchCaptureRefusal = 'uncommitted-changes' | 'fixture-exists' | 'ticket-unresolved' | 'artifact-escapes';

export interface BenchCaptureRequest {
  workingFolder: string;
  fixtureDir: string;
  appHome: string;
  github: BenchGithub;
}

export type BenchCaptureResult = { ok: true } | { ok: false; code: BenchCaptureRefusal };

const refused = (code: BenchCaptureRefusal): BenchCaptureResult => ({ ok: false, code });

function exists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
}

const LOOP_STATE_PREFIX = `${APP_LOOP_DIR_SEGMENTS[0]}/`;

/** AC 8 — modified or staged tracked files and untracked files git does not ignore, outside `.agent-terminal/`. */
async function hasUncommittedChanges(dir: string): Promise<boolean> {
  const status = await runAppCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], dir);
  return status
    .split('\0')
    .filter((entry) => entry.length > 0)
    .some((entry) => !entry.slice(3).startsWith(LOOP_STATE_PREFIX));
}

/** The folder's ticket number, read the way the flow machine reads its `github-ticket` input. */
function ticketOf(dir: string, appHome: string, inputs: Record<string, string>): { name: string; number: number } | null {
  const load = createRunResolver(appHome)(dir).load;
  if (!load.ok) return null;
  const ticket = flowTypedInput(load.definition, 'github-ticket');
  if (ticket === undefined || !Object.prototype.hasOwnProperty.call(inputs, ticket.name)) return null;
  const number = readWholeNumber(inputs[ticket.name]);
  return isFixtureIssueNumber(number) ? { name: ticket.name, number } : null;
}

type ArtifactWalk = { ok: true; files: Map<string, Buffer> } | { ok: false };

/** Every artifact file, relative path → bytes, each entry confined to the folder's artifacts jail (CWE-22/59). */
function readArtifacts(dir: string): ArtifactWalk {
  const jail = resolveJail(dir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  if (jail === null) return { ok: false };
  const files = new Map<string, Buffer>();
  // The directories on the current path only, so a link back up is not followed while a link to a sibling is.
  const ancestors = new Set<string>();
  const walk = (real: string, rel: string): boolean => {
    if (ancestors.has(real)) return true;
    ancestors.add(real);
    for (const entry of readDirEntries(real)) {
      const res = confinedRealPathResult(jail, path.join(real, entry.name));
      if (!res.ok) return false;
      const entryRel = rel === '' ? entry.name : path.join(rel, entry.name);
      const stat = statSync(res.path);
      if (stat.isDirectory()) {
        if (!walk(res.path, entryRel)) return false;
      } else if (stat.isFile()) files.set(entryRel, readFileSync(res.path));
    }
    ancestors.delete(real);
    return true;
  };
  const root = confinedRealPathResult(jail, jail);
  return root.ok && walk(root.path, '') ? { ok: true, files } : { ok: false };
}

/** Removes a fixture folder it could not finish, so a failed write leaves no half-written fixture. */
function writeFixture(fixtureDir: string, fixture: BenchFixture, artifacts: Map<string, Buffer>): BenchCaptureResult {
  mkdirSync(path.dirname(fixtureDir), { recursive: true });
  try {
    mkdirSync(fixtureDir);
  } catch (e) {
    if (isErrno(e, 'EEXIST')) return refused('fixture-exists');
    throw e;
  }
  try {
    for (const [rel, bytes] of artifacts) {
      const file = path.join(fixtureDir, BENCH_FIXTURE_ARTIFACTS, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    }
    writeFileSync(path.join(fixtureDir, BENCH_FIXTURE_MANIFEST), serializeBenchFixture(fixture));
  } catch (e) {
    rmSync(fixtureDir, { recursive: true, force: true });
    throw e;
  }
  return { ok: true };
}

/** Writes nothing until every check has passed. */
export async function captureFixture(request: BenchCaptureRequest): Promise<BenchCaptureResult> {
  const { workingFolder: dir, fixtureDir, appHome, github } = request;
  if (exists(fixtureDir)) return refused('fixture-exists');
  if (await hasUncommittedChanges(dir)) return refused('uncommitted-changes');
  const state = createFlowStateStore(dir).read();
  const stateInputs = state?.inputs ?? {};
  const ticket = ticketOf(dir, appHome, stateInputs);
  if (ticket === null) return refused('ticket-unresolved');
  const artifacts = readArtifacts(dir);
  if (!artifacts.ok) return refused('artifact-escapes');

  const commit = parseAppGitObjectId(await runAppCommand('git', ['rev-parse', '--verify', 'HEAD^{commit}'], dir), 'HEAD');
  const branch = currentGitBranch(dir);
  const baseline = baselineForBranch(readBaselineCommit(dir), branch.ok ? branch.branch : null);
  return writeFixture(
    fixtureDir,
    {
      schema_version: BENCH_FIXTURE_SCHEMA,
      commit,
      ...(baseline !== null ? { phase_baseline: baseline.sha } : {}),
      issue: { repository: await github.repositoryOf(dir), number: ticket.number },
      inputs: Object.fromEntries(Object.entries(stateInputs).filter(([name]) => name !== ticket.name)),
      repeat_counts: { ...(state?.repeatCounts ?? {}) },
    },
    artifacts.files,
  );
}
