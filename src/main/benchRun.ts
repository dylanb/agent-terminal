import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BenchGithub } from './benchGithub';
import type { AppLauncher } from './benchLauncher';
import type { BundleLocation } from './bundleLocation';
import { auditRepoDir, auditRootDir } from './auditPaths';
import { benchRootDir, prepareBenchRun, type BenchPrepareFailure } from './benchPrepare';
import { checkBenchRefusals, type BenchFlowRef, type BenchRefusal } from './benchRefusals';
import { flowDefinitionRevision, promptRevision } from './benchRevision';
import { readConfinedTree } from './benchTree';
import { readBoundedNoFollow } from './boundedRead';
import { resolveOwnedDirJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import { parseBenchSpanEnd, type BenchLaunch, type BenchSpan } from '../shared/benchLaunch';
import { BENCH_RUN_AUDIT_DIR, BENCH_RUN_RECORD_FILE, BENCH_RUN_RECORD_SCHEMA, serializeBenchRunRecord, type BenchRunEnding } from '../shared/benchRunRecord';

export type { BenchFlowRef } from './benchRefusals';

export interface BenchClock {
  now(): number;
  stamp(): string;
}

export function createBenchClock(now: () => number): BenchClock {
  return { now, stamp: () => new Date(now()).toISOString().replace(/[-:]/g, '') };
}

/** `output-failed` stops the command after its app ran, naming the run folder, like a preparation failure. */
export type BenchRunRefusal = BenchRefusal | BenchPrepareFailure | 'label-failed' | 'stamp-exists' | 'output-failed';

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
  /** The user-config root loop defs resolve their operator tier under. */
  userConfigRoot: string | null;
  /** Called with each run folder the moment it exists, so an interrupted command has already named it. */
  reportRunFolder(folder: string): void;
  deps: BenchRunDeps;
}

/** `runFolders` names every run folder this command made, the kept folder of a failed preparation included. */
export type BenchRunResult = { ok: true; runFolders: string[] } | { ok: false; code: BenchRunRefusal; runFolders: string[]; reason?: string };

const STAMP = /^[A-Za-z0-9._-]+$/;

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

const MAX_SPAN_END_BYTES = 4096;

/** The ending the app wrote, or `app exited` when it wrote none the reader parses. */
function spanEnding(launch: BenchLaunch): BenchRunEnding {
  const read = readBoundedNoFollow(launch.spanEndFile, MAX_SPAN_END_BYTES);
  const parsed = read.ok ? parseBenchSpanEnd(read.text) : null;
  return parsed?.ok ? parsed.ending : 'app exited';
}

/** The run's §25 audit log, read where the writer files it, into the run folder; none when the app opened none. */
function copyAuditLog(appHome: string, workingFolder: string, runFolder: string): void {
  const tree = readConfinedTree(resolveOwnedDirJail(auditRepoDir(auditRootDir(appHome), workingFolder)));
  if (!tree.ok) throw new Error("the run's audit log resolves outside its folder or cannot be resolved");
  for (const [rel, bytes] of tree.files) {
    const target = path.join(runFolder, BENCH_RUN_AUDIT_DIR, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
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
    if (prepared.runFolder !== null) {
      runFolders.push(prepared.runFolder);
      request.reportRunFolder(prepared.runFolder);
    }
    if (!prepared.ok) return { ok: false, code: prepared.code, runFolders, reason: prepared.reason };
    const { launch } = prepared;
    const definitionRevision = flowDefinitionRevision(accepted.flowText);
    const prompt = promptRevision({ definition: accepted.definition, span: request.span, appBundle: request.deps.appBundle, userConfigRoot: request.userConfigRoot, repoDir: launch.workingFolder });
    const startedAt = clock.now();
    await launcher.open(launch);
    // Date.now() can step back; the record's reader refuses a negative duration.
    const wallClockMs = Math.max(0, clock.now() - startedAt);
    try {
      copyAuditLog(request.appHome, launch.workingFolder, prepared.runFolder);
      writeFileSync(
        path.join(prepared.runFolder, BENCH_RUN_RECORD_FILE),
        serializeBenchRunRecord({
          schema_version: BENCH_RUN_RECORD_SCHEMA,
          flow: { id: accepted.definition.name, definitionRevision },
          promptRevision: prompt,
          fixture: request.fixtureDir,
          span: request.span,
          fixtureIssue: accepted.fixture.issue,
          issueCopy: { number: prepared.issueCopy },
          branch: prepared.branch,
          ending: spanEnding(launch),
          wallClockMs,
        }),
      );
    } catch (e) {
      return { ok: false, code: 'output-failed', runFolders, reason: `${errMsg(e)} (issue copy #${prepared.issueCopy} on branch ${prepared.branch} was created)` };
    }
  }
  return { ok: true, runFolders };
}
