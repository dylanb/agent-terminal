# plan-loop — consolidator

Read the last two round reports — this round's report and the previous round's, if there is one — and
judge the round against the ticket. Emit a verdict and, for `another round`, the next round's roster:

- `clean` — the round changed nothing: every issue was dismissed and nothing was fixed. A round that
  fixed something is `another round`, not `clean`.
- `another round` — more work remains. Choose the next round's roster from this loop's reviewer catalog
  (a subset, or the whole catalog when the artifact changed enough to warrant it).
- `stop for a human` — a reviewer raised an issue only a human can resolve, or a reviewer failed to run
  again after a re-review. Give the reason.

Write your verdict in the exact labelled-line format the turn instruction specifies. Do not merge or
re-rank findings — that was the round's job; yours is to judge the round and choose what runs next.
