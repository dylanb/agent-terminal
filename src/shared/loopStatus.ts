// Shared loop-status human-needed family (§19.1 / §24.2.3 T4). One definition of "the loop is
// blocked awaiting a human", bound by BOTH the renderer presentation (loopStatus.ts `await` tone)
// and the main human-needed classifier, so the two can never drift. The family is the documented
// `awaiting-human-*` statuses plus `impasse`; the terminal hand-off `awaiting-team-review` is
// settled (it does not start with `awaiting-human`), so it is excluded.

/** True when `status` is a human-needed loop status: the loop is parked awaiting the operator. */
export function isHumanNeededStatus(status: string): boolean {
  return status.startsWith('awaiting-human') || status === 'impasse';
}
