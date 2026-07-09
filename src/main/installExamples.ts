// Non-destructive installer for the bundled example flow (§18.1/§23.4). Writes through the hardened
// atomicWriteFileSync (atomicFile.ts, CWE-59). Resolves a case the ticket's result vocabulary leaves
// open: a write the primitive refuses (symlinked container) is a reported error, never folded into
// `skipped` — `skipped` means "left unchanged per the overwrite decision".

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './atomicFile';
import type { InstallExamplesPreview, InstallExamplesResult } from '../shared/ipc';
import { isValidInstallExamplesPreview, isValidInstallExamplesApply } from './ipcValidation';

/** Where the bundle lives and where its files install to (§18.1): `bundleDir` is the resolved
 *  example/flow dir; `targetDir` is the global flow home `<home>/.agent-terminal`. */
export interface ExampleDirs {
  bundleDir: string;
  targetDir: string;
}

const TEMPLATES_SUBDIR = 'todo-templates';

/** The bundled files to install, as paths relative to both the bundle dir and the target dir: the
 *  flow definition plus every file co-located under todo-templates/ (§18.6). Positive by construction
 *  — the bundle root is example/flow, so no loop/skill/command sibling can appear (§18.1 non-goals). */
function installSet(bundleDir: string): string[] {
  const set = ['flow.yaml'];
  let entries: string[];
  try {
    entries = readdirSync(path.join(bundleDir, TEMPLATES_SUBDIR));
  } catch {
    return set;
  }
  for (const name of entries.sort()) {
    const rel = path.join(TEMPLATES_SUBDIR, name);
    if (statSync(path.join(bundleDir, rel)).isFile()) set.push(rel);
  }
  return set;
}

type Classification = 'create' | 'identical' | 'differ';

/** Byte-compare the bundled file against its target: absent → create, equal → identical, else differ.
 *  Byte equality (not text) is the crux of every non-destructive AC — a newline/encoding slip here
 *  mislabels created/skipped. */
function classify(bundleFile: string, targetFile: string): Classification {
  let target: Buffer;
  try {
    target = readFileSync(targetFile);
  } catch {
    return 'create';
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
  const created: string[] = [];
  const overwritten: string[] = [];
  const skipped: string[] = [];
  for (const rel of installSet(bundleDir)) {
    const bundleFile = path.join(bundleDir, rel);
    const targetFile = path.join(targetDir, rel);
    const cls = classify(bundleFile, targetFile);
    // `skipped` is "left unchanged per the decision" — identical always, or a differing target the
    // user declined to overwrite. Absent targets are always created regardless of the decision (§18.1).
    if (cls === 'identical' || (cls === 'differ' && !overwrite)) {
      skipped.push(rel);
      continue;
    }
    let wrote: boolean;
    try {
      wrote = atomicWriteFileSync(targetFile, readFileSync(bundleFile, 'utf8'));
    } catch (e) {
      return { ok: false, error: `Could not install ${rel}: ${errMsg(e)}` };
    }
    // A refused write (symlinked container, CWE-59) is an error, never folded into `skipped`.
    if (!wrote) return { ok: false, error: `Could not install ${rel}: ${targetDir} is not a real directory` };
    (cls === 'create' ? created : overwritten).push(rel);
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
