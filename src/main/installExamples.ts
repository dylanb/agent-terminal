// §18.1/§23.4; writes route through atomicWriteFileSync (CWE-59).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync, isRealContainer } from './atomicFile';
import type { InstallExamplesPreview, InstallExamplesResult } from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

/** `bundleDir` is the resolved example/flow dir; `targetDir` is the global flow home (§18.1). */
export interface ExampleDirs {
  bundleDir: string;
  targetDir: string;
}

const TEMPLATES_SUBDIR = 'todo-templates';

function installSet(bundleDir: string): string[] {
  const set = ['flow.yaml'];
  let entries: string[];
  try {
    entries = readdirSync(path.join(bundleDir, TEMPLATES_SUBDIR));
  } catch {
    return set;
  }
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue; // §18.6: only .md files resolve as todo templates
    const rel = path.join(TEMPLATES_SUBDIR, name);
    if (statSync(path.join(bundleDir, rel)).isFile()) set.push(rel);
  }
  return set;
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function previewInstallExamples(bundleDir: string, targetDir: string): InstallExamplesPreview {
  const conflicts: string[] = [];
  for (const rel of installSet(bundleDir)) {
    if (classify(path.join(bundleDir, rel), path.join(targetDir, rel)) === 'differ') conflicts.push(rel);
  }
  return { conflicts };
}

export function applyInstallExamples(
  bundleDir: string,
  targetDir: string,
  overwrite: boolean,
): InstallExamplesResult {
  // Not redundant with atomicWriteFileSync's per-file container guard (CWE-59): that one misses a
  // symlinked home above a nested write when flow.yaml is skipped and never written directly.
  if (!isRealContainer(targetDir)) return { ok: false, error: `Could not install: ${targetDir} is not a real directory` };
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const rel of installSet(bundleDir)) {
    const bundleFile = path.join(bundleDir, rel);
    const targetFile = path.join(targetDir, rel);
    try {
      const cls = classify(bundleFile, targetFile);
      if (cls === 'identical' || (cls === 'differ' && !overwrite)) {
        skipped.push(rel);
        continue;
      }
      if (!atomicWriteFileSync(targetFile, readFileSync(bundleFile, 'utf8'))) {
        return { ok: false, error: `Could not install ${rel}: ${path.dirname(targetFile)} is not a real directory` };
      }
      (cls === 'create' ? created : overwritten).push(rel);
    } catch (e) {
      return { ok: false, error: `Could not install ${rel}: ${errMsg(e)}` };
    }
  }
  return { ok: true, created, overwritten, skipped };
}

export function handleInstallExamplesPreview(
  m: unknown,
  dirs: () => ExampleDirs,
): InstallExamplesPreview {
  if (!isValidInstallExamplesPreview(m)) return { conflicts: [] };
  const { bundleDir, targetDir } = dirs();
  return previewInstallExamples(bundleDir, targetDir);
}

export function handleInstallExamplesApply(m: unknown, dirs: () => ExampleDirs): InstallExamplesResult {
  if (!isValidInstallExamplesApply(m)) return { ok: false, error: 'invalid install request' };
  const { bundleDir, targetDir } = dirs();
  return applyInstallExamples(bundleDir, targetDir, m.overwrite);
}
