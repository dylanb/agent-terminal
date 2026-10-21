import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { BundleLocation } from './bundleLocation';
import type { FlowDefinition } from './flow';
import { appDefContext } from './appDefContext';
import { isErrno } from './errno';
import { loopDefPromptFiles, resolveLoopDefV2 } from './loopDefV2';
import type { BenchSpan } from '../shared/benchLaunch';
import { resolveStepSpan } from '../shared/flowStepSpan';
import { APP_LOOP_NAMESPACE } from '../shared/loopNamespace';

export interface PromptRevisionQuery {
  definition: FlowDefinition;
  span: BenchSpan;
  appBundle: BundleLocation;
  /** The user-config root loop defs resolve their operator tier under. */
  userConfigRoot: string | null;
  /** The working folder whose repo tier the loop defs resolve through. */
  repoDir: string;
}

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export function flowDefinitionRevision(flowText: string): string {
  return sha256(flowText);
}

/** The hash of `file`'s bytes, or what kept them from being read: never a message, which can name a per-run path. */
function bytesHash(file: string): string {
  try {
    return sha256(readFileSync(file));
  } catch (e) {
    return isErrno(e, 'ENOENT') ? 'absent' : 'unreadable';
  }
}

/** Paths are relative to the def's folder so the tier a byte-identical copy sits in is not hashed. */
function loopLines(loop: string, defDir: string, files: { role: string; file: string }[]): string[] {
  const base = realpathSync(defDir);
  return files.map(({ role, file }) => JSON.stringify([loop, role, path.relative(base, file).split(path.sep).join('/'), bytesHash(file)]));
}

export function promptRevision(query: PromptRevisionQuery): string {
  const { definition, span } = query;
  const range = resolveStepSpan(
    definition.steps.map((s) => s.id),
    span,
  );
  if (!range.ok) throw new Error(`the span ${span.first}..${span.last} does not resolve against ${definition.name}`);
  const ctx = appDefContext(query.appBundle, query.userConfigRoot, query.repoDir, definition.name);
  const loops = new Set<string>();
  for (const step of definition.steps.slice(range.firstIndex, range.lastIndex + 1)) {
    if (step.kind === 'loop' && step.loop !== undefined && step.loopNamespace === APP_LOOP_NAMESPACE) loops.add(step.loop);
  }
  const lines: string[] = [];
  for (const loop of loops) {
    const resolved = resolveLoopDefV2(loop, ctx);
    if (!resolved.ok) lines.push(JSON.stringify([loop, 'unresolved']));
    else lines.push(...loopLines(loop, resolved.defDir, [{ role: 'definition', file: resolved.defFile }, ...loopDefPromptFiles(resolved.def)]));
  }
  return sha256(lines.sort().join('\n'));
}
