import type { InstalledReviewer } from '../../src/main/reviewerAgents';
import type { ReviewerCatalog } from '../../src/main/runReviewers';

/** A whole-flow reviewer catalog; a reviewer that names no definition file was declared in `definitionFile`. */
export function reviewerCatalog(reviewers: readonly (InstalledReviewer & { definitionFile?: string })[], definitionFile = 'test-loop.yaml'): ReviewerCatalog {
  return { reviewers: reviewers.map((reviewer) => ({ definitionFile, ...reviewer })), problems: [] };
}
