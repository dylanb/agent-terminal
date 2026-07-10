// §18.1/§23.4/§26.5; writes route through atomicWriteFileSync (CWE-59).

import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isRealContainer } from './atomicFile';
import type { BundleLocation } from './bundleLocation';
import { resolveExampleCommandsDir, resolveExampleFlowDir, resolveExampleLoopsDir } from './exampleAssets';
import { userConfigCommandsDir, userConfigLoopsDir, userConfigSkillsDir } from './userConfig';
import {
  INSTALL_DESTINATION_IDS,
  type InstallDestinationFiles,
  type InstallDestinationId,
  type InstallExamplesPreview,
  type InstallExamplesResult,
} from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

/** The bundle source and install target of every destination the action seeds. The skills destination
 *  has no bundle dir of its own: its files fan in from every bundled loop's `skills/` (§26.5). */
export interface ExampleDirs {
  flowBundleDir: string;
  flowTargetDir: string;
  loopsBundleDir: string;
  loopsTargetDir: string;
  skillsTargetDir: string;
  commandsBundleDir: string;
  commandsTargetDir: string;
}

/** Resolve the destination set for the running build. The loops target is the NAMED user-config branch,
 *  never `resolveLoopDir`'s precedence-aware answer: an install is global, so it must not land inside
 *  whichever repo the app happens to be pointed at (§24.2.3; CLAUDE.md precedence-aware corollary). */
export function exampleInstallDirs(loc: BundleLocation, flowGlobalDir: string, configDir?: string): ExampleDirs {
  return {
    flowBundleDir: resolveExampleFlowDir(loc),
    flowTargetDir: path.join(flowGlobalDir, '.agent-terminal'),
    loopsBundleDir: resolveExampleLoopsDir(loc),
    loopsTargetDir: userConfigLoopsDir(configDir),
    skillsTargetDir: userConfigSkillsDir(configDir),
    commandsBundleDir: resolveExampleCommandsDir(loc),
    commandsTargetDir: userConfigCommandsDir(configDir),
  };
}

const TEMPLATES_SUBDIR = 'todo-templates';
const SKILLS_SUBDIR = 'skills';

interface PlannedFile {
  rel: string;
  src: string;
}

interface PlannedDestination {
  id: InstallDestinationId;
  targetDir: string;
  files: PlannedFile[];
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
 *  under its own loop directory — which the `loops` destination writes. A copy-out, not a move. */
function skillFiles(loopsBundleDir: string): PlannedFile[] {
  const out: PlannedFile[] = [];
  for (const loop of entriesOf(loopsBundleDir)) {
    if (!loop.isDirectory) continue;
    const skillsRoot = path.join(loopsBundleDir, loop.name, SKILLS_SUBDIR);
    for (const rel of walkFiles(skillsRoot)) out.push({ rel, src: path.join(skillsRoot, rel) });
  }
  return out;
}

function planDestinations(dirs: ExampleDirs): PlannedDestination[] {
  return [
    { id: 'flow', targetDir: dirs.flowTargetDir, files: flowFiles(dirs.flowBundleDir) },
    { id: 'loops', targetDir: dirs.loopsTargetDir, files: filesUnder(dirs.loopsBundleDir) },
    { id: 'skills', targetDir: dirs.skillsTargetDir, files: skillFiles(dirs.loopsBundleDir) },
    { id: 'commands', targetDir: dirs.commandsTargetDir, files: filesUnder(dirs.commandsBundleDir) },
  ];
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

/** CWE-59 / §26.6: `atomicWriteFileSync` refuses a symlinked container, but nothing guards the ancestors
 *  it mkdir's through — a symlink at any segment between `targetDir` and the file's own container would
 *  land the write outside the destination. */
function ancestorsAreReal(targetDir: string, rel: string): boolean {
  const segments = path.dirname(rel).split(path.sep).filter((s) => s !== '' && s !== '.');
  let dir = targetDir;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    if (!isRealContainer(dir)) return false;
  }
  return true;
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

export function previewInstallExamples(dirs: ExampleDirs): InstallExamplesPreview {
  const destinations = planDestinations(dirs).map((dest) => {
    const files = dest.files
      .filter((f) => classify(f.src, path.join(dest.targetDir, f.rel)) === 'differ')
      .map((f) => f.rel);
    return files.length === 0
      ? ({ destination: dest.id, conflict: false } as const)
      : ({ destination: dest.id, conflict: true, files } as const);
  });
  return { destinations };
}

export function applyInstallExamples(dirs: ExampleDirs, replace: InstallDestinationId[]): InstallExamplesResult {
  const plan = planDestinations(dirs).filter((d) => d.files.length > 0);

  for (const dest of plan) {
    if (!isWritableContainer(dest.targetDir)) {
      return { ok: false, error: `Could not install: ${dest.targetDir} cannot be written`, created: [], overwritten: [] };
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
  });

  for (const dest of plan) {
    for (const file of dest.files) {
      const targetFile = path.join(dest.targetDir, file.rel);
      try {
        const cls = classify(file.src, targetFile);
        if (cls === 'identical' || (cls === 'differ' && !consented.has(dest.id))) {
          record(skipped, dest.id, file.rel);
          continue;
        }
        if (!ancestorsAreReal(dest.targetDir, file.rel)) {
          return fail(`Could not install ${file.rel}: a symbolic link stands on the path to it under ${dest.targetDir}`);
        }
        if (!atomicWriteFileSync(targetFile, readFileSync(file.src, 'utf8'))) {
          return fail(`Could not install ${file.rel}: ${path.dirname(targetFile)} is not a real directory`);
        }
        record(cls === 'create' ? created : overwritten, dest.id, file.rel);
      } catch (e) {
        return fail(`Could not install ${file.rel}: ${errMsg(e)}`);
      }
    }
  }
  return { ok: true, created: report(created), overwritten: report(overwritten), skipped: report(skipped) };
}

export function handleInstallExamplesPreview(m: unknown, dirs: () => ExampleDirs): InstallExamplesPreview {
  if (!isValidInstallExamplesPreview(m)) return { destinations: [] };
  return previewInstallExamples(dirs());
}

export function handleInstallExamplesApply(m: unknown, dirs: () => ExampleDirs): InstallExamplesResult {
  if (!isValidInstallExamplesApply(m)) return { ok: false, error: 'invalid install request', created: [], overwritten: [] };
  return applyInstallExamples(dirs(), m.replace);
}
