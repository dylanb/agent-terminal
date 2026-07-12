// §18.1/§23.4/§26.5; writes route through atomicWriteFileSync (CWE-59).

import { accessSync, constants, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isRealContainer } from './atomicFile';
import { confinedRealPathResult, resolveOwnedDirJail, type PathRefusal } from './confinedPath';
import { readDirEntries } from './dirEntries';
import { errMsg, isErrno } from './errno';
import type { BundleLocation } from './bundleLocation';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';
import { listBundledSkills } from './exampleSkills';
import { FLOW_DEF_FILE, flowHomeDir } from './flow';
import { TODO_TEMPLATES_SUBDIR, isTodoTemplateFile, todoTemplatesDir } from './todoTemplate';
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

/** The one place a DestRelativePath is minted. The brand blocks an implicit `string`, but only a check
 *  blocks a wrong one — an absolute path, or one climbing out of its destination, would otherwise travel
 *  as a legal-looking value straight to a write (CWE-22). */
export function destRelative(rel: string): DestRelativePath {
  const norm = path.normalize(rel);
  if (path.isAbsolute(norm) || norm === '..' || norm.startsWith(`..${path.sep}`)) {
    throw new Error(`Not a destination-relative path: ${rel}`);
  }
  return norm as DestRelativePath;
}

/** A file the action installs: where it lands under its destination, and the bundle file it copies from. */
export interface PlannedFile {
  rel: DestRelativePath;
  src: string;
}

/** `null` when the bundle source is absent — a mispackaged build, not an empty tree (§18.1). */
type Plan = PlannedFile[] | null;

function absent(dir: string): boolean {
  try {
    statSync(dir);
    return false;
  } catch (e) {
    return isErrno(e, 'ENOENT');
  }
}

/** CWE-59: a symlink planted in the bundle is skipped, never read through — the bundle is an installed
 *  artifact, not necessarily one this build wrote. */
function walkFiles(dir: string, base: string = dir): DestRelativePath[] {
  const out: DestRelativePath[] = [];
  for (const entry of readDirEntries(dir)) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory) out.push(...walkFiles(abs, base));
    else if (entry.isFile) out.push(destRelative(path.relative(base, abs)));
  }
  return out;
}

function filesUnder(bundleDir: string): Plan {
  if (absent(bundleDir)) return null;
  return walkFiles(bundleDir).map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** Plan `p` unless it is a CONFIRMED non-regular file — a symlink (even to a file) or a special file — which
 *  the kernel would read through (CWE-59). An ABSENT file is still planned, so a mispackaged bundle missing a
 *  required member reports a read error rather than silently installing nothing (§18.1); the same absent-vs-
 *  present-wrong-type split `isRealContainer` makes for a write container. */
function planUnlessLinked(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return true;
  }
}
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** §18.6. The subdir and the extension come from `todoTemplate`'s own definitions — the reader's — so the
 *  installer cannot seed a location or a file type the picker does not read (CLAUDE.md writer↔reader). Each
 *  planned source is a REGULAR file inside a REAL directory: a symlinked flow.yaml, or a symlinked
 *  todo-templates dir, is skipped rather than read through (CWE-59). */
function flowFiles(bundleDir: string): Plan {
  if (absent(bundleDir)) return null;
  const rels: DestRelativePath[] = [];
  if (planUnlessLinked(path.join(bundleDir, FLOW_DEF_FILE))) rels.push(destRelative(FLOW_DEF_FILE));
  const templates = todoTemplatesDir(bundleDir);
  if (isRealDir(templates)) {
    for (const entry of readDirEntries(templates)) {
      if (!entry.isFile || !isTodoTemplateFile(entry.name)) continue;
      rels.push(destRelative(path.join(TODO_TEMPLATES_SUBDIR, entry.name)));
    }
  }
  return rels.map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** Claude Code discovers a skill only as `<skills root>/<skill name>/`, while §26.5 requires each skill
 *  under its own loop directory. Colliding names across loops are refused at build time (exampleSkills). */
function skillFiles(loopsBundleDir: string): Plan {
  if (absent(loopsBundleDir)) return null;
  const out: PlannedFile[] = [];
  for (const skill of listBundledSkills(loopsBundleDir)) {
    for (const rel of walkFiles(skill.dir)) {
      out.push({ rel: destRelative(path.join(skill.name, rel)), src: path.join(skill.dir, rel) });
    }
  }
  return out;
}

export interface InstallDestination {
  id: InstallDestinationId;
  bundleDir: string;
  /** `null` when this destination has no absolute install location — a relative CLAUDE_CONFIG_DIR (config
   *  destinations) or a relative launch home from an empty $HOME (flow). `resolveAll` turns it into a
   *  refusal the user sees rather than a guessed path. */
  targetDir: string | null;
  plan: (bundleDir: string) => Plan;
}

interface DestinationSpec {
  bundle: (loc: BundleLocation) => string;
  target: (flowGlobalDir: string, configDir?: string) => string | null;
  plan: (bundleDir: string) => Plan;
}

/** The loops/skills/commands targets are the NAMED user-config branches (§24.2.3), never `resolveLoopDir`'s
 *  precedence-aware answer: an install wired to that would seed whichever repo the app is pointed at and
 *  leave every other one unseeded. The skills source is the loops bundle — its files fan in from every
 *  loop's `skills/` (§26.5). */
const DESTINATIONS: Record<InstallDestinationId, DestinationSpec> = {
  flow: { bundle: resolveExampleFlowDir, target: (flowGlobalDir) => (path.isAbsolute(flowGlobalDir) ? flowHomeDir(flowGlobalDir) : null), plan: flowFiles },
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
    if (isErrno(e, 'ENOENT')) return 'create';
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
  /** As the user knows it — what a message names. May be a symlink they placed themselves. */
  targetDir: string;
  /** Its symlink-free real location — what the write is confined to and gated on. */
  jail: string;
  files: ResolvedFile[];
}
type Resolution = { ok: true; destinations: ResolvedDestination[] } | { ok: false; error: string };

/** The two refusals call for opposite fixes — replace the link vs. fix the permissions — so the message
 *  names the one that actually happened. */
const refusal = (what: string, dir: string, cause: PathRefusal): string =>
  cause === 'escapes'
    ? `Could not install ${what}: a symbolic link stands on the path to it under ${dir}`
    : `Could not install ${what}: its path under ${dir} could not be resolved — check that every directory on the way to it exists, is readable, and is a directory`;

function resolveAll(destinations: InstallDestination[]): Resolution {
  const out: ResolvedDestination[] = [];
  for (const dest of destinations) {
    if (dest.targetDir === null) {
      // Every install target must be an absolute directory. A relative one — a relative CLAUDE_CONFIG_DIR
      // (loops/skills/commands) or a relative launch home from an empty $HOME (flow) — has no single meaning
      // and would seed into the process cwd, so the whole install refuses rather than guessing (CWE-829).
      return {
        ok: false,
        error:
          `Could not install the ${dest.id} examples: its install location is not an absolute path. ` +
          `Set CLAUDE_CONFIG_DIR (and $HOME) to absolute paths, or unset CLAUDE_CONFIG_DIR to use ~/.claude.`,
      };
    }
    const files = dest.plan(dest.bundleDir);
    if (files === null) {
      return { ok: false, error: `Could not install: the ${dest.id} examples are missing from this build's bundle` };
    }
    const jail = resolveOwnedDirJail(dest.targetDir); // §18.1
    if (jail === null) return { ok: false, error: refusal(dest.id, dest.targetDir, 'unresolvable') };
    const resolved: ResolvedFile[] = [];
    for (const file of files) {
      const real = confinedRealPathResult(jail, path.join(jail, file.rel));
      if (!real.ok) return { ok: false, error: refusal(file.rel, dest.targetDir, real.cause) };
      resolved.push({ rel: file.rel, src: file.src, real: real.path });
    }
    out.push({ id: dest.id, targetDir: dest.targetDir, jail, files: resolved });
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
      if (!isErrno(e, 'ENOENT')) return false;
      const parent = path.dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
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
  // Every container the write will actually enter, not just each destination's root: an unwritable nested
  // directory is detectable before the first write, and §18.1's all-or-nothing covers everything that is.
  for (const dest of plan) {
    for (const dir of new Set([dest.jail, ...dest.files.map((f) => path.dirname(f.real))])) {
      if (!isWritableContainer(dir)) {
        return { ok: false, error: `Could not install: ${dir} cannot be written`, ...empty };
      }
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
        if (!atomicWriteFileSync(file.real, readFileSync(file.src))) return fail(refusal(file.rel, dest.targetDir, 'escapes'));
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
