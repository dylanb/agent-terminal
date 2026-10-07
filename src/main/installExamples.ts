// §18.1/§23.4; writes route through atomicWriteFileSync (CWE-59).

import { lstatSync, readFileSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFileSync, isWritableContainer } from './atomicFile';
import { confinedRealPathResult, resolveOwnedDirJail, type PathRefusal } from './confinedPath';
import { readDirEntries } from './dirEntries';
import { errMsg, isErrno } from './errno';
import type { BundleLocation } from './bundleLocation';
import {
  FEATURE_DEV_ID,
  resolveExampleCommandsDir,
  resolveExampleFlowsDir,
  resolveFeatureDevFlowDir,
  resolveExampleLoopsV2Dir,
} from './exampleAssets';
import { FLOW_DEF_FILE, flowCatalogDir, flowHomeDir } from './flow';
import { TODO_TEMPLATES_SUBDIR, isTodoTemplateFile, todoTemplatesDir } from './todoTemplate';
import { isSafeCatalogId } from '../shared/pathSegment';
import { userConfigCommandsDir, userConfigLoopsV2Dir } from './userConfig';
import { flowLoopsDir } from './loopDefV2';
import {
  INSTALL_DESTINATION_IDS,
  type DestRelativePath,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
  type InstallPreviewId,
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

/** A bundle member that is neither a regular file nor a directory — a symlink above all. The bundle is an
 *  installed artifact, not necessarily one this build wrote, so it is never read through (CWE-59). It is
 *  REFUSED rather than skipped: skipping seeds a destination with less than the bundle shipped and reports
 *  success, and where the member is required (`flow.yaml`) the destination plans zero files, is dropped from
 *  the apply, and the user is told an install worked that never happened (§18.1 — a detectable bundle
 *  problem is a named refusal, never a successful install of nothing). The build-time guard
 *  (`exampleAssetsBuild`) keeps one out of the tree; this is the second line, for a bundle on disk. */
const bundleAnomaly = (p: string): Error =>
  new Error(`the bundled examples are damaged: a symbolic link or special file stands at ${p}, which this build will not read through`);

function walkFiles(dir: string, base: string = dir): DestRelativePath[] {
  const out: DestRelativePath[] = [];
  for (const entry of readDirEntries(dir)) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory) out.push(...walkFiles(abs, base));
    else if (entry.isFile) out.push(destRelative(path.relative(base, abs)));
    else throw bundleAnomaly(abs);
  }
  return out;
}

function filesUnder(bundleDir: string): Plan {
  if (absent(bundleDir)) return null;
  return walkFiles(bundleDir).map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** A required bundle member must be a REGULAR file, or absent. Absent is still planned, so a mispackaged
 *  bundle missing it reports a read error rather than silently installing nothing (§18.1). PRESENT but not
 *  regular — a symlink (even to a file), a special file — is refused (`bundleAnomaly`). */
function requireRegularIfPresent(p: string): void {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return;
    throw e;
  }
  if (!st.isFile()) throw bundleAnomaly(p);
}
/** True for a REAL directory, false when ABSENT — a bundle shipping no `todo-templates/` is a legitimate
 *  empty, not a broken build. Present but not a real directory (a symlinked one above all) is refused, as is
 *  a member this build cannot read at all: the absent-vs-unreadable split `readDirEntries` makes for the
 *  enumeration itself (CLAUDE.md; §18.1). */
function isRealDir(p: string): boolean {
  let st;
  try {
    st = lstatSync(p);
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
  if (!st.isDirectory()) throw bundleAnomaly(p);
  return true;
}

/** §18.6. The subdir and the extension come from `todoTemplate`'s own definitions — the reader's — so the
 *  installer cannot seed a location or a file type the picker does not read (CLAUDE.md writer↔reader). Each
 *  planned source is a REGULAR file inside a REAL directory: a symlinked flow.yaml, or a symlinked
 *  todo-templates dir, is refused rather than read through (CWE-59). `null` when the flow-home dir is absent
 *  (a mispackaged bundle, not an empty tree). Shared by the global-fallback `flow` destination and each
 *  catalog entry, so a catalog flow home is read exactly as the fallback one is. */
function flowHomeRels(flowHomeBundleDir: string): DestRelativePath[] | null {
  if (absent(flowHomeBundleDir)) return null;
  const rels: DestRelativePath[] = [];
  requireRegularIfPresent(path.join(flowHomeBundleDir, FLOW_DEF_FILE));
  rels.push(destRelative(FLOW_DEF_FILE));
  const templates = todoTemplatesDir(flowHomeBundleDir);
  if (isRealDir(templates)) {
    for (const entry of readDirEntries(templates)) {
      if (!entry.isFile || !isTodoTemplateFile(entry.name)) continue;
      rels.push(destRelative(path.join(TODO_TEMPLATES_SUBDIR, entry.name)));
    }
  }
  return rels;
}

function flowFiles(bundleDir: string): Plan {
  const rels = flowHomeRels(bundleDir);
  if (rels === null) return null;
  return rels.map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** A catalog entry whose directory name is not a safe catalog id (§18.7.6): the name becomes a path segment
 *  the resolver later walks, so a bundle that ships one is refused rather than seeded (CWE-22). */
const unsafeCatalogId = (p: string, name: string): Error =>
  new Error(`the bundled examples are damaged: the catalog entry ${JSON.stringify(name)} at ${p} is not a valid flow id`);

/** An existing-but-empty catalog root (CWE-754): the shipped catalog always carries feature-dev-v2 and at least
 *  one more (§18.1/§18.7.1), so a zero-flow tree is a mispackaged bundle. It is a named refusal — never
 *  resolved as zero files and reported as a successful install of nothing (§18.1). `null` stays reserved for
 *  an ABSENT tree (the `Plan` contract), so present-but-empty gets its own reason rather than "missing". */
const emptyCatalog = (p: string): Error =>
  new Error(`the bundled examples are damaged: the flow catalog at ${p} contains no flows`);

/** §18.7.1. `null` when the catalog bundle is absent, so a mispackaged tree is a named refusal, never a
 *  successful install of nothing — present-but-damaged throws instead (§18.1, the `Plan` null contract). */
function catalogFiles(catalogBundleDir: string): Plan {
  if (absent(catalogBundleDir)) return null;
  const entries = readDirEntries(catalogBundleDir);
  if (entries.length === 0) throw emptyCatalog(catalogBundleDir);
  const out: PlannedFile[] = [];
  for (const entry of entries) {
    const abs = path.join(catalogBundleDir, entry.name);
    if (!entry.isDirectory) throw bundleAnomaly(abs);
    if (!isSafeCatalogId(entry.name)) throw unsafeCatalogId(abs, entry.name);
    const rels = flowHomeRels(abs);
    if (rels === null) throw bundleAnomaly(abs);
    for (const rel of rels) out.push({ rel: destRelative(path.join(entry.name, rel)), src: path.join(abs, rel) });
  }
  return out;
}

export interface InstallDestination {
  id: InstallDestinationId;
  bundleDir: string;
  overwrite: { mode: 'confirm-overwrite' } | { mode: 'forbid-overwrite' };
  /** `null` when this destination has no absolute install location — a relative CLAUDE_CONFIG_DIR (config
   *  destinations) or a relative launch home from an empty $HOME (flow). `resolveAll` turns it into a
   *  refusal the user sees rather than a guessed path. */
  targetDir: string | null;
  /** What the user must fix when `targetDir` is null: the root THIS destination derives from, and no other.
   *  The flow home comes from $HOME, the config branches from CLAUDE_CONFIG_DIR — so one refusal text for
   *  both names a variable that is blameless for whichever destination actually failed. */
  rootFix: string;
  plan: (bundleDir: string) => Plan;
}

interface DestinationSpec {
  bundle: (loc: BundleLocation) => string;
  target: (flowGlobalDir: string, configDir?: string) => string | null;
  rootFix: string;
  plan: (bundleDir: string) => Plan;
  overwrite: InstallDestination['overwrite'];
}

const CONFIG_ROOT_FIX = 'Set CLAUDE_CONFIG_DIR to an absolute path, or unset it to use ~/.claude.';
const HOME_ROOT_FIX = 'Set $HOME to an absolute path.';

/** §18.1/§27.15. */
const DESTINATIONS: Record<InstallDestinationId, DestinationSpec> = {
  flow: {
    bundle: resolveFeatureDevFlowDir,
    target: (flowGlobalDir) => (path.isAbsolute(flowGlobalDir) ? flowHomeDir(flowGlobalDir) : null),
    rootFix: HOME_ROOT_FIX,
    plan: flowFiles,
    overwrite: { mode: 'confirm-overwrite' },
  },
  flowCatalog: {
    bundle: resolveExampleFlowsDir,
    target: (flowGlobalDir) => (path.isAbsolute(flowGlobalDir) ? flowCatalogDir(flowGlobalDir) : null),
    rootFix: HOME_ROOT_FIX,
    plan: catalogFiles,
    overwrite: { mode: 'confirm-overwrite' },
  },
  appLoops: {
    bundle: resolveExampleLoopsV2Dir,
    target: (_flow, cfg) => {
      const root = userConfigLoopsV2Dir(cfg);
      return root === null ? null : flowLoopsDir(root, FEATURE_DEV_ID);
    },
    rootFix: CONFIG_ROOT_FIX,
    plan: filesUnder,
    overwrite: { mode: 'confirm-overwrite' },
  },
  commands: {
    bundle: resolveExampleCommandsDir,
    target: (_flow, cfg) => userConfigCommandsDir(cfg),
    rootFix: CONFIG_ROOT_FIX,
    plan: filesUnder,
    overwrite: { mode: 'confirm-overwrite' },
  },
};

/** Resolve every destination for the running build: its bundle source from `loc`, its install target
 *  from the user's surfaces. Order is the contract's, so the report cannot be reordered against it. */
export function exampleInstallDirs(loc: BundleLocation, flowGlobalDir: string, configDir?: string): InstallDestination[] {
  return INSTALL_DESTINATION_IDS.map((id) => {
    const d = DESTINATIONS[id];
    return {
      id,
      bundleDir: d.bundle(loc),
      targetDir: d.target(flowGlobalDir, configDir),
      rootFix: d.rootFix,
      plan: d.plan,
      overwrite: d.overwrite,
    };
  });
}

type Classification = 'create' | 'identical' | 'differ';

function allowsOverwrite(
  overwrite: InstallDestination['overwrite'],
): boolean {
  return overwrite.mode === 'confirm-overwrite';
}

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
  overwrite: InstallDestination['overwrite'];
}
type Resolution = { ok: true; destinations: ResolvedDestination[] } | { ok: false; error: string };

/** The two refusals call for opposite fixes — replace the link vs. fix the permissions — so the message
 *  names the one that actually happened. */
const refusal = (what: string, dir: string, cause: PathRefusal): string =>
  cause === 'escapes'
    ? `Could not install ${what}: a symbolic link stands on the path to it under ${dir}`
    : `Could not install ${what}: its path under ${dir} could not be resolved — check that every directory on the way to it exists, is a directory, and is readable and traversable`;

function resolveAll(destinations: InstallDestination[]): Resolution {
  const out: ResolvedDestination[] = [];
  for (const dest of destinations) {
    if (dest.targetDir === null) {
      // Every install target must be an absolute directory. A relative one — a relative CLAUDE_CONFIG_DIR
      // (loops/skills/commands) or a relative launch home from an empty $HOME (flow) — has no single meaning
      // and would seed into the process cwd, so the whole install refuses rather than guessing (CWE-829).
      // The remediation is the destination's own: the two roots are independent, and either can be the
      // sole cause while the other is absolute and blameless.
      return {
        ok: false,
        error: `Could not install the ${dest.id} examples: its install location is not an absolute path. ${dest.rootFix}`,
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
    out.push({
      id: dest.id,
      targetDir: dest.targetDir,
      jail,
      files: resolved,
      overwrite: dest.overwrite,
    });
  }
  return { ok: true, destinations: out };
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

interface InstallFileSnapshot {
  destination: InstallDestinationId;
  rel: DestRelativePath;
  src: string;
  real: string;
  sourceHash: string;
  targetHash: string | null;
}

interface InstallAuthorization {
  files: InstallFileSnapshot[];
  conflicts: Set<InstallDestinationId>;
}

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function targetHash(file: string): string | null {
  try {
    return hash(readFileSync(file));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

function snapshotFile(
  destination: InstallDestinationId,
  file: ResolvedFile,
): InstallFileSnapshot {
  return {
    destination,
    rel: file.rel,
    src: file.src,
    real: file.real,
    sourceHash: hash(readFileSync(file.src)),
    targetHash: targetHash(file.real),
  };
}

function captureInstallSnapshot(
  destinations: ResolvedDestination[],
): InstallFileSnapshot[] {
  return destinations.flatMap((destination) =>
    destination.files.map((file) => snapshotFile(destination.id, file)),
  );
}

function snapshotKey(
  destination: InstallDestinationId,
  rel: DestRelativePath,
): string {
  return `${destination}\0${rel}`;
}

function sameSnapshot(
  expected: InstallFileSnapshot,
  actual: InstallFileSnapshot,
): boolean {
  return (
    expected.destination === actual.destination &&
    expected.rel === actual.rel &&
    expected.src === actual.src &&
    expected.real === actual.real &&
    expected.sourceHash === actual.sourceHash &&
    expected.targetHash === actual.targetHash
  );
}

function verifyAuthorization(
  destinations: ResolvedDestination[],
  authorization: InstallAuthorization,
): string | null {
  const actual = captureInstallSnapshot(destinations);
  if (actual.length !== authorization.files.length) {
    return 'the install file set changed after preview';
  }
  const expected = new Map(
    authorization.files.map((file) => [
      snapshotKey(file.destination, file.rel),
      file,
    ]),
  );
  for (const file of actual) {
    const previewed = expected.get(snapshotKey(file.destination, file.rel));
    if (previewed === undefined || !sameSnapshot(previewed, file)) {
      return `the install target changed after preview: ${file.real}`;
    }
  }
  return null;
}

interface PreparedInstallExamples {
  destinations: InstallDestinationPreview[];
  authorization: InstallAuthorization;
}

type InstallExamplesPreparation =
  | { ok: true; prepared: PreparedInstallExamples }
  | { ok: false; error: string };

function prepareInstallExamples(
  destinations: InstallDestination[],
): InstallExamplesPreparation {
  let resolution: Resolution;
  try {
    resolution = resolveAll(destinations);
  } catch (error) {
    return {
      ok: false,
      error: `Could not check the install targets: ${errMsg(error)}`,
    };
  }
  if (!resolution.ok) return resolution;

  try {
    const files = captureInstallSnapshot(resolution.destinations);
    const conflicts = new Set<InstallDestinationId>();
    const previews = resolution.destinations.map((destination) => {
      const differing = files
        .filter(
          (file) =>
            file.destination === destination.id &&
            file.targetHash !== null &&
            file.targetHash !== file.sourceHash,
        )
        .map((file) => file.rel);
      if (differing.length === 0) {
        return {
          destination: destination.id,
          conflict: false as const,
        };
      }
      if (!allowsOverwrite(destination.overwrite)) {
        throw new Error(
          `Could not install ${destination.id}: its overwrite policy does not authorize replacing ${differing.join(', ')}`,
        );
      }
      conflicts.add(destination.id);
      return {
        destination: destination.id,
        conflict: true as const,
        files: differing,
      };
    });
    return {
      ok: true,
      prepared: {
        destinations: previews,
        authorization: { files, conflicts },
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `Could not check the install targets: ${errMsg(error)}`,
    };
  }
}

export type InstallExamplesInspection =
  | { ok: true; destinations: InstallDestinationPreview[] }
  | { ok: false; error: string };

export function previewInstallExamples(
  destinations: InstallDestination[],
): InstallExamplesInspection {
  const preparation = prepareInstallExamples(destinations);
  if (!preparation.ok) return preparation;
  return {
    ok: true,
    destinations: preparation.prepared.destinations,
  };
}

function applyInstallExamplesWithAuthorization(
  destinations: InstallDestination[],
  replace: InstallDestinationId[],
  authorization?: InstallAuthorization,
): InstallExamplesResult {
  const empty = { created: [], overwritten: [], skipped: [] };
  let resolution: Resolution;
  try {
    resolution = resolveAll(destinations);
  } catch (e) {
    return { ok: false, error: `Could not install: ${errMsg(e)}`, ...empty };
  }
  if (!resolution.ok) return { ok: false, error: resolution.error, ...empty };
  if (authorization !== undefined) {
    let changed: string | null;
    try {
      changed = verifyAuthorization(
        resolution.destinations,
        authorization,
      );
    } catch (error) {
      return {
        ok: false,
        error: `Could not verify install confirmation: ${errMsg(error)}`,
        ...empty,
      };
    }
    if (changed !== null) {
      return {
        ok: false,
        error: `Could not install: ${changed}; preview again`,
        ...empty,
      };
    }
  }

  const plan = resolution.destinations.filter((d) => d.files.length > 0);
  try {
    for (const dest of plan) {
      if (
        !allowsOverwrite(dest.overwrite) &&
        dest.files.some((file) => classify(file.src, file.real) === 'differ')
      ) {
        return {
          ok: false,
          error: `Could not install ${dest.id}: its overwrite policy does not authorize replacing existing files`,
          ...empty,
        };
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not install: ${errMsg(e)}`,
      ...empty,
    };
  }
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
  const expected = new Map(
    (authorization?.files ?? []).map((file) => [
      snapshotKey(file.destination, file.rel),
      file,
    ]),
  );
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
        if (authorization !== undefined) {
          const previewed = expected.get(snapshotKey(dest.id, file.rel));
          if (
            previewed === undefined ||
            !sameSnapshot(previewed, snapshotFile(dest.id, file))
          ) {
            return fail(
              `Could not install ${file.rel}: its source or target changed after preview; preview again`,
            );
          }
        }
        const cls = classify(file.src, file.real);
        if (cls === 'identical' || (cls === 'differ' && !consented.has(dest.id))) {
          record(skipped, dest.id, file.rel);
          continue;
        }
        if (cls === 'differ' && !allowsOverwrite(dest.overwrite)) {
          return fail(`Could not install ${file.rel}: its overwrite policy does not authorize replacement`);
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

export function applyInstallExamples(
  destinations: InstallDestination[],
  replace: InstallDestinationId[],
): InstallExamplesResult {
  return applyInstallExamplesWithAuthorization(destinations, replace);
}

function failedInstall(error: string): InstallExamplesResult {
  return {
    ok: false,
    error,
    created: [],
    overwritten: [],
    skipped: [],
  };
}

export interface InstallExamplesCoordinator {
  preview(message: unknown): InstallExamplesPreview;
  apply(message: unknown): InstallExamplesResult;
}

export function createInstallExamplesCoordinator(
  dirs: () => InstallDestination[],
): InstallExamplesCoordinator {
  let pending:
    | { previewId: string; authorization: InstallAuthorization }
    | undefined;

  return {
    preview(message) {
      pending = undefined;
      if (!isValidInstallExamplesPreview(message)) {
        return { ok: false, error: 'invalid preview request' };
      }
      const preparation = prepareInstallExamples(dirs());
      if (!preparation.ok) return preparation;
      const previewId = randomUUID() as InstallPreviewId;
      pending = {
        previewId,
        authorization: preparation.prepared.authorization,
      };
      return {
        ok: true,
        previewId,
        destinations: preparation.prepared.destinations,
      };
    },
    apply(message) {
      if (!isValidInstallExamplesApply(message)) {
        return failedInstall('invalid install request');
      }
      const confirmation = pending;
      if (
        confirmation === undefined ||
        confirmation.previewId !== message.previewId
      ) {
        return failedInstall(
          'install preview is missing, stale, or already used; preview again',
        );
      }
      pending = undefined;
      if (
        message.replace.some(
          (destination) =>
            !confirmation.authorization.conflicts.has(destination),
        )
      ) {
        return failedInstall(
          'install request names a replacement that was not offered in its preview',
        );
      }
      return applyInstallExamplesWithAuthorization(
        dirs(),
        message.replace,
        confirmation.authorization,
      );
    },
  };
}
