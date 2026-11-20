import { createHash } from 'node:crypto';
import { resolvedReviewerIdentity, RUN_REVIEWER_PREFIX, type ResolvedReviewerIdentity } from '../shared/resolvedReviewer';

export function resolvedReviewerName(reviewer: ResolvedReviewerIdentity): string {
  return `${RUN_REVIEWER_PREFIX}${createHash('sha256').update(resolvedReviewerIdentity(reviewer)).digest('hex').slice(0, 32)}`;
}

export function resolvedReviewerFile(reviewer: ResolvedReviewerIdentity): string {
  return `${resolvedReviewerName(reviewer)}.md`;
}
