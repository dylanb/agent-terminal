// §18.1/§23.4/§26.5; writes route through atomicWriteFileSync (CWE-59).

import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isRealContainer } from './atomicFile';
import { confinedRealPath, resolveNewDirJail } from './confinedPath';
import type { BundleLocation } from './bundleLocation';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';
import { listBundledSkills } from './exampleSkills';
import { flowHomeDir } from './flow';
import { userConfigCommandsDir, userConfigLoopsDir, userConfigSkillsDir } from './userConfig';
import {
  INSTALL_DESTINATION_IDS,
  type DestRelativePath,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

const TEMPLATES_SUBDIR = 'todo-templates';

/** A file the action installs: where it lands under its destination, and the bundle file it copies from. */
export interface PlannedFile {
  rel: DestRelativePath;
  src: string;
}

/** A destination's plan, or `null` when its bundle source is ABSENT — a tree missing from the running
 *  build. Enumeration is tree-driven (§18.1), so an absent tree would otherwise plan zero files and
 *  install nothing while reporting success. An absent tree is not an empty one. */
type Plan = PlannedFile[] | null;

function absent(dir: string): boolean {
  try {
    statSync(dir);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Absence is the ONLY enumeration failure that reads as "no files here" (an optional subtree, e.g. a loop
 *  with no `skills/`). Anything else — EACCES on an unreadable install, ENOTDIR on a corrupt one — throws,
 *  because a swallowed failure here is indistinguishable from an empty tree and installs nothing while
 *  reporting success. */
function entriesOf(dir: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

/** CWE-59: a symlink planted in the bundle is skipped, never read through — the bundle is an installed
 *  artifact, not necessarily one this build wrote. */
function walkFiles(dir: string, base: string = dir): DestRelativePath[] {
  const out: DestRelativePath[] = [];
  for (const entry of entriesOf(dir)) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory) out.push(...walkFiles(abs, base));
    else if (entry.isFile) out.push(path.relative(base, abs) as DestRelativePath);
  }
  return out;
}

function filesUnder(bundleDir: string): Plan {
  if (absent(bundleDir)) return null;
  return walkFiles(bundleDir).map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** §18.6: only `.md` files resolve as todo templates. */
function flowFiles(bundleDir: string): Plan {
  if (absent(bundleDir)) return null;
  const rels: DestRelativePath[] = ['flow.yaml' as DestRelativePath];
  for (const entry of entriesOf(path.join(bundleDir, TEMPLATES_SUBDIR))) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    rels.push(path.join(TEMPLATES_SUBDIR, entry.name) as DestRelativePath);
  }
  return rels.map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** Claude Code discovers a skill only as `<skills root>/<skill name>/`, while §26.5 requires each skill
 *  under its own loop directory. Colliding names across loops are refused at build time (exampleSkills). */
function skillFiles(loopsBundleDir: string): Plan {
  if (absent(loopsBundleDir)) return null;
  const out: PlannedFile[] = [];
  for (const skill of listBundledSkills(loopsBundleDir)) {
    for (const rel of walkFiles(skill.dir, skill.root)) out.push({ rel, src: path.join(skill.root, rel) });
  }
  return out;
}

/** A resolved install destination: where its files come from, where they go, and how to enumerate them.
 *  `plan` is opaque to callers — only preview/apply invoke it — so a destination's file strategy can
 *  change without touching the seam. Tests override `bundleDir` to point at a broken or empty bundle. */
export interface InstallDestination {
  id: InstallDestinationId;
  bundleDir: string;
  targetDir: string;
  plan: (bundleDir: string) => Plan;
}

interface DestinationSpec {
  bundle: (loc: BundleLocation) => string;
  target: (flowGlobalDir: string, configDir?: string) => string;
  plan: (bundleDir: string) => Plan;
}

/** The loops/skills/commands targets are the NAMED user-config branches (§24.2.3), never `resolveLoopDir`'s
 *  precedence-aware answer: an install wired to that would seed whichever repo the app is pointed at and
 *  leave every other one unseeded. The skills source is the loops bundle — its files fan in from every
 *  loop's `skills/` (§26.5). */
const DESTINATIONS: Record<InstallDestinationId, DestinationSpec> = {
  flow: { bundle: resolveExampleFlowDir, target: (flowGlobalDir) => flowHomeDir(flowGlobalDir), plan: flowFiles },
  loops: { bundle: resolveExampleLoopsDir, target: (_flow, cfg) => userConfigLoopsDir(cfg), plan: filesUnder },
  skills: { bundle: resolveExampleLoopsDir, target: (_flow, cfg) => userConfigSkillsDir(cfg), plan: skillFiles },
  commands: { bundle: resolveExampleCommandsDir, target: (_flow, cfg) => userConfigCommandsDir(cfg), plan: filesUnder },
};

/** Resolve every destination for the running build: its bundle source from `loc`, its install target
 *  from the user's surfaces. Order is the contract's, so the report cannot be reordered against it. */
export function exampleInstallDirs(loc: BundleLocation, flowGlobalDir: string, configDir?: string): InstallDestination[] {
  return INSTALL_DESTINATION_IDS.map((id) => {
    const d = DESTINATIONS[id];
    return { id, bundleDir: d.bundle(loc), targetDir: d.target(flowGlobalDir, configDir), plan: d.plan };
  });
}

type Classification = 'create' | 'identical' | 'differ';

function classify(bundleFile: string, targetFile: string): Classification {
  let target: Buffer;
  try {
    target = readFileSync(targetFile);
  } catch (e) {
    // Only absence means "create"; an existing-but-unreadable target (EACCES, …) must not be silently
    // overwritten — let it propagate to a reported error, preserving the non-destructive contract.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'create';
    throw e;
  }
  return readFileSync(bundleFile).equals(target) ? 'identical' : 'differ';
}

/** A destination resolved for work: its plan, and the symlink-free real path each file resolves to inside
 *  the destination's jail. Preview and apply both read targets, so BOTH route through this — a read that
 *  followed a symlink out would classify (and show the user a consent step computed from) bytes outside
 *  the destination the installer would never have written (CWE-22/59/367). */
interface ResolvedFile {
  rel: DestRelativePath;
  src: string;
  real: string;
}
interface ResolvedDestination {
  id: InstallDestinationId;
  targetDir: string;
  files: ResolvedFile[];
}
type Resolution = { ok: true; destinations: ResolvedDestination[] } | { ok: false; error: string };

const linkRefusal = (rel: string, dir: string): string =>
  `Could not install ${rel}: a symbolic link stands on the path to it under ${dir}`;

function resolveAll(destinations: InstallDestination[]): Resolution {
  const out: ResolvedDestination[] = [];
  for (const dest of destinations) {
    const files = dest.plan(dest.bundleDir);
    if (files === null) {
      return { ok: false, error: `Could not install: the ${dest.id} examples are missing from this build's bundle` };
    }
    const jail = resolveNewDirJail(dest.targetDir);
    const resolved: ResolvedFile[] = [];
    for (const file of files) {
      const real = jail === null ? null : confinedRealPath(jail, path.join(dest.targetDir, file.rel));
      if (real === null) return { ok: false, error: linkRefusal(file.rel, dest.targetDir) };
      resolved.push({ rel: file.rel, src: file.src, real });
    }
    out.push({ id: dest.id, targetDir: dest.targetDir, files: resolved });
  }
  return { ok: true, destinations: out };
}

/** CWE-59: a symlinked container would land the write outside the destination, and the loops container
 *  confers §26.6 `exec` authority on what lands there (CWE-829). */
function isWritableContainer(dir: string): boolean {
  if (!isRealContainer(dir)) return false;
  let probe = dir;
  for (;;) {
    try {
      accessSync(probe, constants.W_OK);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Groups = Map<InstallDestinationId, DestRelativePath[]>;

function record(groups: Groups, id: InstallDestinationId, rel: DestRelativePath): void {
  const list = groups.get(id);
  if (list) list.push(rel);
  else groups.set(id, [rel]);
}

function report(groups: Groups): InstallDestinationFiles[] {
  return INSTALL_DESTINATION_IDS.filter((id) => (groups.get(id)?.length ?? 0) > 0).map((id) => ({
    destination: id,
    files: groups.get(id) as DestRelativePath[],
  }));
}

export function previewInstallExamples(destinations: InstallDestination[]): InstallExamplesPreview {
  let resolution: Resolution;
  try {
    resolution = resolveAll(destinations);
  } catch (e) {
    return { ok: false, error: `Could not check the install targets: ${errMsg(e)}` };
  }
  if (!resolution.ok) return resolution;

  const out: InstallDestinationPreview[] = [];
  for (const dest of resolution.destinations) {
    let files: DestRelativePath[];
    try {
      files = dest.files.filter((f) => classify(f.src, f.real) === 'differ').map((f) => f.rel);
    } catch (e) {
      // classify rethrows a non-ENOENT read (an unreadable target). The contract carries a refusal arm for
      // exactly this: an empty destination list would otherwise read as "nothing conflicts" and drive an
      // apply the user never consented to.
      return { ok: false, error: `Could not check the install targets: ${errMsg(e)}` };
    }
    out.push(files.length === 0 ? { destination: dest.id, conflict: false } : { destination: dest.id, conflict: true, files });
  }
  return { ok: true, destinations: out };
}

export function applyInstallExamples(destinations: InstallDestination[], replace: InstallDestinationId[]): InstallExamplesResult {
  const empty = { created: [], overwritten: [], skipped: [] };
  let resolution: Resolution;
  try {
    resolution = resolveAll(destinations);
  } catch (e) {
    return { ok: false, error: `Could not install: ${errMsg(e)}`, ...empty };
  }
  if (!resolution.ok) return { ok: false, error: resolution.error, ...empty };

  const plan = resolution.destinations.filter((d) => d.files.length > 0);
  for (const dest of plan) {
    if (!isWritableContainer(dest.targetDir)) {
      return { ok: false, error: `Could not install: ${dest.targetDir} cannot be written`, ...empty };
    }
  }

  const consented = new Set(replace);
  const created: Groups = new Map();
  const overwritten: Groups = new Map();
  const skipped: Groups = new Map();
  const fail = (error: string): InstallExamplesResult => ({
    ok: false,
    error,
    created: report(created),
    overwritten: report(overwritten),
    skipped: report(skipped),
  });

  for (const dest of plan) {
    for (const file of dest.files) {
      try {
        const cls = classify(file.src, file.real);
        if (cls === 'identical' || (cls === 'differ' && !consented.has(dest.id))) {
          record(skipped, dest.id, file.rel);
          continue;
        }
        // Bytes, not text: the bundle is a tree the build ships, and decoding a non-UTF-8 asset would both
        // corrupt it and leave it permanently `differ` against the byte-compare that classifies it.
        if (!atomicWriteFileSync(file.real, readFileSync(file.src))) return fail(linkRefusal(file.rel, dest.targetDir));
        record(cls === 'create' ? created : overwritten, dest.id, file.rel);
      } catch (e) {
        return fail(`Could not install ${file.rel}: ${errMsg(e)}`);
      }
    }
  }
  return { ok: true, created: report(created), overwritten: report(overwritten), skipped: report(skipped) };
}

export function handleInstallExamplesPreview(m: unknown, dirs: () => InstallDestination[]): InstallExamplesPreview {
  if (!isValidInstallExamplesPreview(m)) return { ok: false, error: 'invalid preview request' };
  return previewInstallExamples(dirs());
}

export function handleInstallExamplesApply(m: unknown, dirs: () => InstallDestination[]): InstallExamplesResult {
  if (!isValidInstallExamplesApply(m)) return { ok: false, error: 'invalid install request', created: [], overwritten: [], skipped: [] };
  return applyInstallExamples(dirs(), m.replace);
}
