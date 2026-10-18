# plan-loop — consolidator

Read the last two round reports — this round's report and the previous round's, if there is one — and
judge the round against the ticket. Emit a verdict and, for `another round`, the next round's roster:

- `clean` — the round changed nothing except documentation, by this rule. A round whose issues are all
  dismissed or `fixed — documentation` is `clean`: it changed nothing except documentation, and
  `dismissed — nit` counts as a dismissal. A round with any `fixed` issue is `another round`, however many
  NIT dismissals and documentation fixes it also records. A round that records a `needs a human` issue is
  judged by the `stop for a human` rule.
- `another round` — more work remains. Choose the next round's roster from this loop's reviewer catalog:
  prefer the SMALLEST roster that covers the open work — the lenses that raised an unresolved issue this
  round plus any whose subject the round's fixes actually touched. Do not re-summon a lens that returned
  clean for a change elsewhere, and drop any lens whose subject the artifact does not contain (no code →
  no tests/taint/accessibility lens). Re-run the whole catalog only when a structural change genuinely
  warrants fresh eyes across every lens.
- `stop for a human` — a reviewer raised an issue only a human can resolve, or a reviewer failed to run
  again after a re-review. Give the reason.

Then read the plan's `## Complexity drivers`. Its items belong to the operator, so this rule
takes precedence over `clean` and `another round`: the verdict is `stop for a human` when any item there is
not recorded as `Operator decision (<date>): …`. Name each undecided criterion in the reason, with the
recommendation the plan gives it.

Write your verdict in the exact JSON format the turn instruction specifies. Do not merge or
re-rank findings — that was the round's job; yours is to judge the round and choose what runs next.
