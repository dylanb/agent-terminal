/** The gate side-effect vocabulary a def declares (§27.13): the `gh` actions the executor dispatches, and the
 *  epic promotion's own kind. The executor and the flow-load check both read these, so they cannot disagree. */
export const GH_ACTION = {
  markReady: 'mark-ready',
  updateIssueBody: 'update-issue-body',
  publishPrBody: 'publish-pr-body',
  publishPrReview: 'publish-pr-review',
} as const;

export const PROMOTE_KIND = 'promote';

/** The effects that act on a ticket run's own issue, draft PR or epic. */
export const TICKET_RUN_EFFECTS: ReadonlySet<string> = new Set([GH_ACTION.updateIssueBody, GH_ACTION.markReady, GH_ACTION.publishPrBody, PROMOTE_KIND]);
