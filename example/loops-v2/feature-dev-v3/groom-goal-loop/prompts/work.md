# groom-goal-loop — work turn

Groom the linked GitHub issue into the `groomed-ticket` artifact, review it, and fix it until the review
ends, deciding every question yourself as the brief says.

1. Read the `groom-intent` input, then the issue, its comments and linked issues, and the code, spec and
   standards it touches.
2. Write the groomed ticket against the ticket standards in `CLAUDE.md`: an imperative title, the problem with a
   spec citation, scope and non-goals, and acceptance criteria as measurable outcomes. Open it with a `## MVP`
   section stating the user, the problem, the outcome and the success signal, and make every acceptance
   criterion serve it. Test each criterion against the stated problem, and drop, narrow or split out to a
   follow-up ticket any the problem does not need, logging each as a decision.
3. Review the ticket with the reviewers below, then fix or dismiss every finding, logging each in
   `## Review history` and each decision a fix needs in `## Groomer decisions`. Never fix a NIT: log each NIT
   as `dismissed — nit`, with its reason, in groom-report.md's review history.
4. Repeat step 3 until the review ends, as the review rules in these instructions say.
