// §18.1/§23.4/§26.5; writes route through atomicWriteFileSync (CWE-59).

import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isRealContainer } from './atomicFile';
import { confinedRealPath, resolveNewDirJail } from './confinedPath';
import type { BundleLocation } from './bundleLocation';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';
import { listBundledSkills } from './exampleSkills';
import { userConfigCommandsDir, userConfigLoopsDir, userConfigSkillsDir } from './userConfig';
import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallDestinationPreview,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

const TEMPLATES_SUBDIR = 'todo-templates';

/** A file the action installs: its path relative to the destination root, and the bundle file it copies
 *  from. */
export interface PlannedFile {
  rel: string;
  src: string;
}

function entriesOf(dir: string): { name: string; isDirectory: boolean; isFile: boolean }[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
  } catch {
    return [];
  }
}

/** CWE-59: a symlink planted in the bundle is skipped, never read through — the bundle is an installed
 *  artifact, not necessarily one this build wrote. */
function walkFiles(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of entriesOf(dir)) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory) out.push(...walkFiles(abs, base));
    else if (entry.isFile) out.push(path.relative(base, abs));
  }
  return out;
}

function filesUnder(bundleDir: string): PlannedFile[] {
  return walkFiles(bundleDir).map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** §18.6: only `.md` files resolve as todo templates. */
function flowFiles(bundleDir: string): PlannedFile[] {
  const rels = ['flow.yaml'];
  for (const entry of entriesOf(path.join(bundleDir, TEMPLATES_SUBDIR))) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    rels.push(path.join(TEMPLATES_SUBDIR, entry.name));
  }
  return rels.map((rel) => ({ rel, src: path.join(bundleDir, rel) }));
}

/** Claude Code discovers a skill only as `<skills root>/<skill name>/`, while §26.5 requires each skill
 *  under its own loop directory. Colliding names across loops are refused at build time (exampleSkills). */
function skillFiles(loopsBundleDir: string): PlannedFile[] {
  const out: PlannedFile[] = [];
  for (const skill of listBundledSkills(loopsBundleDir)) {
    const skillsRoot = path.dirname(skill.dir);
    for (const rel of walkFiles(skill.dir, skillsRoot)) out.push({ rel, src: path.join(skillsRoot, rel) });
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
  plan: (bundleDir: string) => PlannedFile[];
}

interface DestinationSpec {
  bundle: (loc: BundleLocation) => string;
  target: (flowGlobalDir: string, configDir?: string) => string;
  plan: (bundleDir: string) => PlannedFile[];
}

/** The one registry of destination identity: bundle source, install target, and file-planning strategy,
 *  keyed by the contract's own ids so `Record<InstallDestinationId, …>` fails to compile if an id is
 *  missing or unknown — the registry and INSTALL_DESTINATION_IDS cannot drift in membership. Order is not
 *  stored here: `exampleInstallDirs` iterates INSTALL_DESTINATION_IDS, the single source of the display
 *  order (§18.1). The loops/skills/commands targets are the NAMED user-config branches (§24.2.3; CLAUDE.md
 *  precedence-aware corollary), never `resolveLoopDir`'s precedence-aware answer: a global install must not
 *  land inside whichever repo the app happens to be pointed at. The skills source is the loops bundle —
 *  its files fan in from every loop's `skills/` (§26.5). */
const DESTINATIONS: Record<InstallDestinationId, DestinationSpec> = {
  flow: { bundle: resolveExampleFlowDir, target: (flowGlobalDir) => path.join(flowGlobalDir, '.agent-terminal'), plan: flowFiles },
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

type Groups = Map<InstallDestinationId, string[]>;

function record(groups: Groups, id: InstallDestinationId, rel: string): void {
  const list = groups.get(id);
  if (list) list.push(rel);
  else groups.set(id, [rel]);
}

function report(groups: Groups): InstallDestinationFiles[] {
  return INSTALL_DESTINATION_IDS.filter((id) => (groups.get(id)?.length ?? 0) > 0).map((id) => ({
    destination: id,
    files: groups.get(id) as string[],
  }));
}

export function previewInstallExamples(destinations: InstallDestination[]): InstallDestinationPreview[] {
  return destinations.map((dest) => {
    const files = dest
      .plan(dest.bundleDir)
      .filter((f) => classify(f.src, path.join(dest.targetDir, f.rel)) === 'differ')
      .map((f) => f.rel);
    return files.length === 0
      ? ({ destination: dest.id, conflict: false } as const)
      : ({ destination: dest.id, conflict: true, files } as const);
  });
}

export function applyInstallExamples(destinations: InstallDestination[], replace: InstallDestinationId[]): InstallExamplesResult {
  const plan = destinations
    .map((d) => ({ id: d.id, targetDir: d.targetDir, files: d.plan(d.bundleDir) }))
    .filter((d) => d.files.length > 0);

  for (const dest of plan) {
    if (!isWritableContainer(dest.targetDir)) {
      return { ok: false, error: `Could not install: ${dest.targetDir} cannot be written`, created: [], overwritten: [], skipped: [] };
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
    // One jail per destination; confinedRealPath refuses a file whose path escapes it and returns the
    // symlink-free real path for the rest, so classify reads and the write lands on that path (CWE-367).
    const jail = resolveNewDirJail(dest.targetDir);
    for (const file of dest.files) {
      try {
        const real = jail === null ? null : confinedRealPath(jail, path.join(dest.targetDir, file.rel));
        if (real === null) {
          return fail(`Could not install ${file.rel}: a symbolic link stands on the path to it under ${dest.targetDir}`);
        }
        const cls = classify(file.src, real);
        if (cls === 'identical' || (cls === 'differ' && !consented.has(dest.id))) {
          record(skipped, dest.id, file.rel);
          continue;
        }
        if (!atomicWriteFileSync(real, readFileSync(file.src, 'utf8'))) {
          return fail(`Could not install ${file.rel}: a symbolic link stands on the path to it under ${dest.targetDir}`);
        }
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
  return { ok: true, destinations: previewInstallExamples(dirs()) };
}

export function handleInstallExamplesApply(m: unknown, dirs: () => InstallDestination[]): InstallExamplesResult {
  if (!isValidInstallExamplesApply(m)) return { ok: false, error: 'invalid install request', created: [], overwritten: [], skipped: [] };
  return applyInstallExamples(dirs(), m.replace);
}
