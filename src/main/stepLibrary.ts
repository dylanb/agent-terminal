import path from 'node:path';
import { FLOW_HOME_SUBDIR, flowHomeDir } from './flowHome';
import { confinedRealPathResult, resolveJail, resolveOwnedDirJail } from './confinedPath';
import { readBoundedNoFollow } from './boundedRead';
import { errMsg } from './errno';
import { isSafeCatalogId } from '../shared/pathSegment';

export const STEPS_SUBDIR = 'steps';
export const STEP_DEF_EXT = '.yaml';
export const MAX_STEP_DEFINITION_BYTES = 64 * 1024;

/** §18.2 */
export function stepLibraryDir(root: string): string {
  return path.join(flowHomeDir(root), STEPS_SUBDIR);
}

export type StepTierName = 'repo' | 'global' | 'bundled';

/** A repo tier sits in untrusted content and is jailed at the worktree; the others are app-derived directories. */
export type StepTier = { name: 'repo'; worktreeDir: string } | { name: 'global' | 'bundled'; dir: string };

export type StepLookup = { ok: true; raw: string; file: string; tier: StepTierName } | { ok: false; error: string };

export type StepLibrary = (name: string) => StepLookup;

/** Where the running flow's own definition came from: a repository (its catalog tier or a local flow.yaml), or
 *  the global tier (a global catalog entry or the global fallback). */
export type FlowSourceTier = 'repo' | 'global';

/** §18.2 / §18.7.3. A repository flow reads the repository's library, then the global one. A global flow reads
 *  only the global library, so repository content can never change part of a flow the repository did not supply. */
export function runtimeStepTiers(worktreeDir: string, globalDir: string, source: FlowSourceTier): StepTier[] {
  const global: StepTier = { name: 'global', dir: stepLibraryDir(globalDir) };
  return source === 'repo' ? [{ name: 'repo', worktreeDir }, global] : [global];
}

function tierJail(tier: StepTier): string | null {
  return tier.name === 'repo' ? resolveJail(tier.worktreeDir, FLOW_HOME_SUBDIR, STEPS_SUBDIR) : resolveOwnedDirJail(tier.dir);
}

type TierRead = { kind: 'found'; raw: string; file: string } | { kind: 'absent' } | { kind: 'refused'; error: string };

function readFromTier(tier: StepTier, name: string): TierRead {
  const unreadable: TierRead = { kind: 'refused', error: `the ${tier.name} step library could not be read for step definition "${name}"` };
  const jail = tierJail(tier);
  if (jail === null) return unreadable;
  const expected = path.join(jail, `${name}${STEP_DEF_EXT}`);
  const confined = confinedRealPathResult(jail, expected);
  if (!confined.ok) {
    return confined.cause === 'escapes'
      ? { kind: 'refused', error: `step definition "${name}" escapes the ${tier.name} step library` }
      : unreadable;
  }
  if (confined.path !== expected) return { kind: 'refused', error: `step definition "${name}" escapes the ${tier.name} step library` };
  const read = readBoundedNoFollow(expected, MAX_STEP_DEFINITION_BYTES);
  if (read.ok) return { kind: 'found', raw: read.text, file: expected };
  switch (read.cause) {
    case 'absent':
      return { kind: 'absent' };
    case 'over-cap':
      return { kind: 'refused', error: `step definition "${name}" is larger than ${MAX_STEP_DEFINITION_BYTES} bytes` };
    case 'unreadable':
      return {
        kind: 'refused',
        error: `cannot read step definition "${name}": ${read.error === undefined ? 'not a regular file' : errMsg(read.error)}`,
      };
    default:
      return read.cause satisfies never;
  }
}

/** §18.2 */
export function createStepLibrary(tiers: StepTier[]): StepLibrary {
  return (name) => {
    if (!isSafeCatalogId(name)) return { ok: false, error: `"${name}" is not a valid step name` };
    for (const tier of tiers) {
      const r = readFromTier(tier, name);
      if (r.kind === 'found') return { ok: true, raw: r.raw, file: r.file, tier: tier.name };
      if (r.kind === 'refused') return { ok: false, error: r.error };
    }
    return { ok: false, error: `step definition "${name}" was not found in the ${tiers.map((t) => t.name).join(' or ')} step library` };
  };
}
