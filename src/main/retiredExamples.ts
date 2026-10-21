// §18.1 v2.212.

import { readDirEntries } from './dirEntries';
import type { ReviewerAgentFormat } from './reviewerAgents';

export const RETIRED_FLOW_IDS: readonly string[] = ['feature-dev', 'feature-dev-v2'];

/** The loops only the retired flows shipped. */
export const RETIRED_LOOPS: readonly string[] = ['plan-bundle-loop', 'plan-polish-loop'];

/** The names directly under an installed destination root that a retired flow left there. */
export type RetiredLister = (root: string) => string[];

export const retiredFlowFolders: RetiredLister = (root) =>
  readDirEntries(root)
    .filter((e) => RETIRED_FLOW_IDS.includes(e.name))
    .map((e) => e.name);

export const retiredReviewerAgents =
  (format: ReviewerAgentFormat): RetiredLister =>
  (root) => {
    const prefixes = RETIRED_LOOPS.map((loop) => format.name(loop, ''));
    return readDirEntries(root)
      .filter((e) => e.name.endsWith(format.extension) && prefixes.some((p) => e.name.startsWith(p)))
      .map((e) => e.name);
  };
