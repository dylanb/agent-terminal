export interface ResolvedReviewerIdentity {
  loop: string;
  persona: string;
  charter: string;
  tools: 'all' | readonly string[];
}

export const RUN_REVIEWER_PREFIX = 'agent-terminal--';
export const RUN_REVIEWER_FILE_GLOB = `${RUN_REVIEWER_PREFIX}*.md`;

export function resolvedReviewerIdentity(reviewer: ResolvedReviewerIdentity): string {
  return JSON.stringify([reviewer.loop, reviewer.persona, reviewer.charter, reviewer.tools]);
}
