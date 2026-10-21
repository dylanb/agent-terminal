// §27.10 — the pickup a run completed, in its own file under the run's identity, so a relaunch resumes the run
// with the PR its pickup opened and never with one an earlier run left.

import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { APP_LOOP_STATE_SCHEMA, isNonBlank, isPositiveInt, loopAreaFile, type AppLoopBootstrap } from './appLoopState';
import { sameRun, type RunIdentity } from './gateRunState';
import { isRecord } from './yamlRecord';
import { errMsg } from './errno';

const RUN_PICKUP_FILE = 'run-pickup.yaml';

export interface TrustedPickups {
  get(repoDir: string): AppLoopBootstrap | undefined;
  set(repoDir: string, pickup: AppLoopBootstrap): void;
  delete(repoDir: string): void;
}

export interface TrustedPickupsDeps {
  currentRun(repoDir: string): RunIdentity | null;
  persistFailed(repoDir: string, reason: string): void;
}

export function createTrustedPickups(deps: TrustedPickupsDeps): TrustedPickups {
  const loaded = new Map<string, AppLoopBootstrap>();
  return {
    get(repoDir) {
      const cached = loaded.get(repoDir);
      if (cached !== undefined) return cached;
      const run = deps.currentRun(repoDir);
      const persisted = run === null ? null : readRunPickup(repoDir);
      if (run === null || persisted === null || !sameRun(persisted.run, run)) return undefined;
      loaded.set(repoDir, persisted.pickup);
      return persisted.pickup;
    },
    set(repoDir, pickup) {
      loaded.set(repoDir, pickup);
      const run = deps.currentRun(repoDir);
      try {
        if (run === null) throw new Error('no run is in progress');
        writeRunPickup(repoDir, run, pickup);
      } catch (e) {
        deps.persistFailed(repoDir, errMsg(e));
      }
    },
    delete(repoDir) {
      loaded.delete(repoDir);
      const file = loopAreaFile(repoDir, RUN_PICKUP_FILE);
      if (file !== null) rmSync(file, { force: true });
    },
  };
}

function writeRunPickup(repoDir: string, run: RunIdentity, pickup: AppLoopBootstrap): void {
  const file = loopAreaFile(repoDir, RUN_PICKUP_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const doc = {
    schema_version: APP_LOOP_STATE_SCHEMA,
    flow: run.flow,
    started_at: run.startedAt,
    pr: pickup.pr,
    branch: pickup.branch,
    issue: pickup.issue,
    initial_status: pickup.initialStatus,
  };
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §27 run pickup: ${path.dirname(file)} is not a real directory`);
  }
}

function readRunPickup(repoDir: string): { run: RunIdentity; pickup: AppLoopBootstrap } | null {
  const file = loopAreaFile(repoDir, RUN_PICKUP_FILE);
  if (file === null) return null;
  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isRecord(doc) || String(doc.schema_version) !== String(APP_LOOP_STATE_SCHEMA)) return null;
  const { flow, started_at, pr, branch, issue, initial_status } = doc;
  if (typeof flow !== 'string' || typeof started_at !== 'number' || !Number.isFinite(started_at)) return null;
  if (!isPositiveInt(pr) || !isPositiveInt(issue) || !isNonBlank(branch) || !isNonBlank(initial_status)) return null;
  return { run: { flow, startedAt: started_at }, pickup: { pr, branch, issue, initialStatus: initial_status } };
}
