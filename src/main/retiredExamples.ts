// §18.1 v2.212.

import { readDirEntries } from './dirEntries';
import type { ReviewerAgentFormat } from './reviewerAgents';
import { RETIRED_FLOW_IDS } from '../shared/retiredFlows';

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

/** The names directly under an installed destination root that a retired flow left there. */
export type RetiredLister = (root: string) => string[];

const entriesNamed =
  (names: readonly string[]): RetiredLister =>
  (root) =>
    readDirEntries(root)
      .filter((e) => names.includes(e.name))
      .map((e) => e.name);

export const retiredCatalogEntries: RetiredLister = entriesNamed(RETIRED_FLOW_IDS);

export const retiredLoopFolders: RetiredLister = entriesNamed(RETIRED_LOOP_FOLDERS);

export const retiredReviewerAgents = (format: ReviewerAgentFormat): RetiredLister =>
  entriesNamed(
    Object.entries(RETIRED_LOOP_REVIEWERS).flatMap(([loop, personas]) => personas.map((persona) => `${format.name(loop, persona)}${format.extension}`)),
  );
