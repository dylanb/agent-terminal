// §27.10 — the pickup a run completed, in its own file under the run's identity, so a relaunch resumes the run
// with the PR its pickup opened and never with one an earlier run left.

import path from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import yaml from 'js-yaml';
import { atomicWriteFileSync } from './atomicFile';
import { APP_LOOP_STATE_SCHEMA, isNonBlank, isPositiveInt, loopAreaFile, type AppLoopBootstrap } from './appLoopState';
import { APP_LOOP_DIR_SEGMENTS } from './appLoopPaths';
import { sameRun, type RunIdentity } from './gateRunState';
import { isRecord } from './yamlRecord';
import { errMsg } from './errno';
import { isAdoptedPickup, parseAdoptedPickup, serializeAdoptedPickup, type AdoptedPickup } from '../shared/appBootstrap';

const RUN_PICKUP_FILE = 'run-pickup.yaml';

/** The pickup a run's side effects trust: the ticket run's opened draft PR, or the PR it adopted. */
export type RunPickup = AppLoopBootstrap | AdoptedPickup;

export interface TrustedPickups {
  get(repoDir: string): RunPickup | undefined;
  set(repoDir: string, pickup: RunPickup): void;
  /** Whether the saved file is gone; this app trusts the forgotten run's pickup no more either way. */
  delete(repoDir: string): boolean;
  /** Forget the pickup only once its saved file is gone; when it cannot be removed, nothing changes. */
  forgetIfRemovable(repoDir: string): boolean;
}

export function runPickupRel(): string {
  return [...APP_LOOP_DIR_SEGMENTS, RUN_PICKUP_FILE].join('/');
}

export interface TrustedPickupsDeps {
  currentRun(repoDir: string): RunIdentity | null;
  persistFailed(repoDir: string, reason: string): void;
  forgetFailed(repoDir: string, reason: string): void;
}

export function createTrustedPickups(deps: TrustedPickupsDeps): TrustedPickups {
  const loaded = new Map<string, { run: RunIdentity | null; pickup: RunPickup }>();
  const forgotten = new Map<string, RunIdentity>();
  const forgottenRun = (repoDir: string): RunIdentity | null =>
    loaded.get(repoDir)?.run ?? readRunPickup(repoDir)?.run ?? deps.currentRun(repoDir);
  return {
    get(repoDir) {
      const run = deps.currentRun(repoDir);
      const cached = loaded.get(repoDir);
      if (cached !== undefined) {
        if (cached.run === null || (run !== null && sameRun(cached.run, run))) return cached.pickup;
        loaded.delete(repoDir);
      }
      if (run === null) return undefined;
      const lost = forgotten.get(repoDir);
      if (lost !== undefined && sameRun(lost, run)) return undefined;
      const persisted = readRunPickup(repoDir);
      if (persisted === null || !sameRun(persisted.run, run)) return undefined;
      loaded.set(repoDir, persisted);
      return persisted.pickup;
    },
    set(repoDir, pickup) {
      const run = deps.currentRun(repoDir);
      loaded.set(repoDir, { run, pickup });
      forgotten.delete(repoDir);
      try {
        if (run === null) throw new Error('no run is in progress');
        writeRunPickup(repoDir, run, pickup);
      } catch (e) {
        deps.persistFailed(repoDir, errMsg(e));
      }
    },
    delete(repoDir) {
      const run = forgottenRun(repoDir);
      loaded.delete(repoDir);
      if (run !== null) forgotten.set(repoDir, run);
      const removed = remove(repoDir);
      if (!removed.ok) deps.forgetFailed(repoDir, removed.reason);
      return removed.ok;
    },
    forgetIfRemovable(repoDir) {
      if (!remove(repoDir).ok) return false;
      loaded.delete(repoDir);
      return true;
    },
  };
}

function remove(repoDir: string): { ok: true } | { ok: false; reason: string } {
  try {
    const file = loopAreaFile(repoDir, RUN_PICKUP_FILE);
    if (file !== null) rmSync(file, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errMsg(e) };
  }
}

function writeRunPickup(repoDir: string, run: RunIdentity, pickup: RunPickup): void {
  const file = loopAreaFile(repoDir, RUN_PICKUP_FILE);
  if (file === null) throw new Error('§27 loop area is unresolvable');
  const runFields = { schema_version: APP_LOOP_STATE_SCHEMA, flow: run.flow, started_at: run.startedAt };
  let doc: Record<string, unknown>;
  if (isAdoptedPickup(pickup)) {
    doc = { ...runFields, ...serializeAdoptedPickup(pickup) };
    if (pickup.startedAt !== run.startedAt || !parseAdoptedPickup(doc).ok) throw new Error('invalid §27 run pickup');
  } else {
    if (!isPositiveInt(pickup.pr) || !isPositiveInt(pickup.issue) || !isNonBlank(pickup.branch) || !isNonBlank(pickup.initialStatus)) {
      throw new Error('invalid §27 run pickup');
    }
    doc = { ...runFields, pr: pickup.pr, branch: pickup.branch, issue: pickup.issue, initial_status: pickup.initialStatus };
  }
  if (!atomicWriteFileSync(file, yaml.dump(doc))) {
    throw new Error(`cannot write §27 run pickup: ${path.dirname(file)} is not a real directory`);
  }
}

function readRunPickup(repoDir: string): { run: RunIdentity; pickup: RunPickup } | null {
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
  const run = { flow, startedAt: started_at };
  if (doc.kind !== undefined) {
    const adopted = parseAdoptedPickup(doc);
    return adopted.ok ? { run, pickup: adopted.pickup } : null;
  }
  if (!isPositiveInt(pr) || !isPositiveInt(issue) || !isNonBlank(branch) || !isNonBlank(initial_status)) return null;
  return { run, pickup: { pr, branch, issue, initialStatus: initial_status } };
}
