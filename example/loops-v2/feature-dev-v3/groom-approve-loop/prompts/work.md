# groom-approve-loop — work turn

Present the groomed ticket for the operator's approval.

Read the `groom-intent`, `groomed-ticket` and `groom-report` inputs and the GitHub issue as it stands. Write the
`groom-summary` artifact and show it to the operator in this terminal, with these parts in this order:

1. `## Needs your call` — every item from the report's `## Needs your call`, each with its options and the
   groomer's recommendation. Say plainly when there is none.
2. `## What changed` — the MVP in one paragraph, then how the groomed ticket differs from the issue as it
   stands: criteria added, dropped, narrowed or split out, and scope or non-goals that moved.
3. `## Groomer decisions` — the report's decisions, the ones with the most impact on the user first, each in
   one or two lines: the question, the choice, and why.
4. `## Review history` — how many review passes ran, what they found, and what was fixed or dismissed.

End by telling the operator they can approve as is at the gate, which publishes the groomed ticket to the
issue, or ask you for changes here first.

Once you have written the done-signal, stay in this session. When the operator asks for a change, make it in
the groomed ticket, record it in `groom-report.md` as an `Operator decision (<date>): …`, keep the groomed
ticket's last line as it is, and tell them what changed. The operator approves at the gate when they are
satisfied.
