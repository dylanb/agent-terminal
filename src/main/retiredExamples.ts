// §18.1.

import { lstatSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readDirEntries } from './dirEntries';
import { isErrno } from './errno';
import { listLoopFolders } from './loopFolders';
import type { ReviewerAgentFormat } from './reviewerAgents';
import { RETIRED_FLOW_IDS } from '../shared/retiredFlows';
import type { RetiredKind } from '../shared/ipc';

/** The loops only the retired flows shipped, each with the reviewer personas it installed as sub-agents. */
const RETIRED_LOOP_REVIEWERS: Readonly<Record<string, readonly string[]>> = {
  'plan-bundle-loop': ['review-plan-intent', 'review-plan-principal', 'review-plan-tracer-slicer'],
  'plan-polish-loop': [
    'review-plan-architecture',
    'review-plan-contracts',
    'review-plan-determinism',
    'review-plan-intent',
    'review-plan-maintainability',
    'review-plan-principal',
    'review-plan-security',
    'review-plan-test-architect',
    'review-plan-tracer-slicer',
  ],
};

export const RETIRED_LOOPS: readonly string[] = Object.keys(RETIRED_LOOP_REVIEWERS);

/** Per-flow loop folders began with #179, the change that renamed feature-dev to feature-dev-v2, so no build
 *  ever wrote one for feature-dev. */
const RETIRED_LOOP_FOLDERS: readonly string[] = ['feature-dev-v2'];

export const MOVED_LOOPS: Readonly<Record<string, readonly string[]>> = {
  'simple-dev-v1': [
    'simple-plan-approve-loop-v1',
    'simple-dev-loop-v1',
    'simple-integration-slice-loop-v1',
    'simple-impl-approve-loop-v1',
    'simple-finalize-loop-v1',
  ],
};

export interface RetiredEntry {
  rel: string;
  kind: RetiredKind;
}

/** What an older build left under an installed destination root, given the bundle this build installs there. */
export type RetiredLister = (root: string, bundleDir: string) => RetiredEntry[];

const entriesNamed =
  (names: readonly string[]): RetiredLister =>
  (root) =>
    readDirEntries(root)
      .filter((e) => names.includes(e.name))
      .map((e) => ({ rel: e.name, kind: 'retired-flow' }));

export const retiredCatalogEntries: RetiredLister = entriesNamed(RETIRED_FLOW_IDS);

function isRealDirectory(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return false;
    throw e;
  }
}

export function removeRetiredEntry(jail: string, rel: string, kind: RetiredKind): void {
  if (kind === 'moved-loop') {
    let dir = jail;
    for (const segment of path.dirname(rel).split(path.sep)) {
      dir = path.join(dir, segment);
      if (!isRealDirectory(dir)) throw new Error(`${segment} is no longer a real folder`);
    }
  }
  // `rm` removes a symbolic link itself, never what it points at.
  rmSync(path.join(jail, rel), { recursive: true, force: true });
}

/** Removal deletes `<root>/<rel>` recursively, and a nested `rel` would follow a symbolic link standing at
 *  the flow's folder out of the root, so a flow folder that is not a real directory offers nothing. */
const movedLoopCopies: RetiredLister = (root, bundleDir) => {
  const shippedPerFlow = new Set(listLoopFolders(bundleDir).flatMap((f) => (f.flow === null ? [] : [path.join(f.flow, f.name)])));
  return Object.entries(MOVED_LOOPS).flatMap(([flow, loops]) => {
    const flowDir = path.join(root, flow);
    if (!isRealDirectory(flowDir)) return [];
    return readDirEntries(flowDir)
      .filter((e) => loops.includes(e.name))
      .map((e) => path.join(flow, e.name))
      .filter((rel) => !shippedPerFlow.has(rel))
      .map((rel) => ({ rel, kind: 'moved-loop' as const }));
  });
};

export const retiredLoopFolders: RetiredLister = (root, bundleDir) => [
  ...entriesNamed(RETIRED_LOOP_FOLDERS)(root, bundleDir),
  ...movedLoopCopies(root, bundleDir),
];

export const retiredReviewerAgents = (format: ReviewerAgentFormat): RetiredLister =>
  entriesNamed(
    Object.entries(RETIRED_LOOP_REVIEWERS).flatMap(([loop, personas]) => personas.map((persona) => `${format.name(loop, persona)}${format.extension}`)),
  );
