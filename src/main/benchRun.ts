// #180 — `bench run`: the refusals, the `bench-run` label, then N runs one after another, each prepared from the
// fixture, launched and waited for.

import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BenchGithub } from './benchGithub';
import type { AppLauncher } from './benchLauncher';
import type { BundleLocation } from './bundleLocation';
import { benchRootDir, prepareBenchRun, type BenchPrepareFailure } from './benchPrepare';
import { checkBenchRefusals, type BenchFlowRef, type BenchRefusal } from './benchRefusals';
import { errMsg, isErrno } from './errno';
import type { BenchSpan } from '../shared/benchLaunch';

export type { BenchFlowRef } from './benchRefusals';

export interface BenchClock {
  now(): number;
  /** One path segment of `[A-Za-z0-9._-]`, naming one command's runs. */
  stamp(): string;
}

/** The production clock over `now`, the epoch-ms time source the entry supplies. The stamp is the UTC instant to
 *  the millisecond, `20261020T120000.001Z`. */
export function createBenchClock(now: () => number): BenchClock {
  return { now, stamp: () => new Date(now()).toISOString().replace(/[-:]/g, '') };
}

export type BenchRunRefusal = BenchRefusal | BenchPrepareFailure | 'label-failed' | 'stamp-exists';

export interface BenchRunDeps {
  github: BenchGithub;
  launcher: AppLauncher;
  appBundle: BundleLocation;
  clock: BenchClock;
}

export interface BenchRunRequest {
  flow: BenchFlowRef;
  span: BenchSpan;
  fixtureDir: string;
  /** The run count as the operator wrote it. */
  runs: string;
  invokingRepo: string;
  appHome: string;
  /** The user-config root loop defs resolve their operator tier under; none when null. */
  userConfigRoot: string | null;
  deps: BenchRunDeps;
}

/** `runFolders` names every run folder this command made, the kept folder of a failed preparation included. */
export type BenchRunResult = { ok: true; runFolders: string[] } | { ok: false; code: BenchRunRefusal; runFolders: string[]; reason?: string };

const STAMP = /^[A-Za-z0-9._-]+$/;

/** This command's folder, made with a mkdir that fails when it exists, so two commands never share runs. */
function makeStampDir(appHome: string, stamp: string): string | null {
  if (!STAMP.test(stamp) || stamp === '.' || stamp === '..') throw new Error(`the clock's stamp is not one path segment: ${stamp}`);
  const root = benchRootDir(appHome);
  mkdirSync(root, { recursive: true });
  try {
    mkdirSync(path.join(root, stamp));
  } catch (e) {
    if (isErrno(e, 'EEXIST')) return null;
    throw e;
  }
  return realpathSync(path.join(root, stamp));
}

export async function runBench(request: BenchRunRequest): Promise<BenchRunResult> {
  const { github, launcher, clock } = request.deps;
  const check = await checkBenchRefusals({ ...request, github, appBundle: request.deps.appBundle });
  if (!check.ok) return { ok: false, code: check.code, runFolders: [] };
  const { accepted } = check;

  try {
    await github.ensureBenchRunLabel(accepted.fixture.issue.repository);
  } catch (e) {
    return { ok: false, code: 'label-failed', runFolders: [], reason: errMsg(e) };
  }

  const stamp = clock.stamp();
  const stampDir = makeStampDir(request.appHome, stamp);
  if (stampDir === null) return { ok: false, code: 'stamp-exists', runFolders: [] };

  const runFolders: string[] = [];
  for (let run = 1; run <= accepted.runs; run++) {
    const prepared = await prepareBenchRun({ invokingRepo: request.invokingRepo, appHome: request.appHome, fixtureDir: request.fixtureDir, accepted, span: request.span, stampDir, stamp, run, github });
    if (prepared.runFolder !== null) runFolders.push(prepared.runFolder);
    if (!prepared.ok) return { ok: false, code: prepared.code, runFolders, reason: prepared.reason };
    await launcher.open(prepared.launch);
  }
  return { ok: true, runFolders };
}
