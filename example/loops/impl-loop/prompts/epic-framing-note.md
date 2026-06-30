# Epic sub-ticket brief — draft at impl-phase entry (every K)

This run is part of an auto-chained epic. The engine fires this template
at sub-ticket K's impl-phase entry — for K = 1 (initial entry from the
plan loop) AND for K ≥ 2 (after the predecessor's clean impl gate
advances the chain). The work-agent reads the resulting file on **turn 1**
of every sub-ticket's impl phase before touching code.

**Write the file.** Put your response in
`.agent-loop/epic-sub-ticket-brief.md` inside the working directory
(relative path, overwrite if present). Do not print the body back as
your chat reply — only a one-line confirmation that the file was written
and its byte count.

## Token budget

Cap the body at roughly 200–500 tokens. The work-agent reads this on
impl-turn 1; brevity is mercy. Anything that would already be obvious
from re-reading the master plan, the sub-ticket issue body, or the
previous sub-ticket's diff does NOT belong here.

## Body structure — always emit all five headings, in this order

Always include every heading below. When a section has nothing to say,
emit a single line `None.` under that heading (do not omit the heading
itself, and do not add commentary explaining the omission). This keeps
the file's shape predictable for the work-agent that consumes it.

````markdown
## Your slice

One short paragraph (2–4 sentences) naming what THIS sub-ticket K owns
of the epic's surface. Quote the planner's `### Sub-ticket K` line from
`plan.md`'s `## Per-sub-ticket ACs` partition — that section is the
authoritative record of which ACs map to which K. Pair it with the
Epic Breakdown bullet's title and one-line scope. Explicit, not implied.

## Just shipped

One short paragraph (2–4 sentences) naming what predecessor sub-ticket
K-1 (and earlier, when relevant) delivered. File-and-shape level, not
diff-hunk level: which modules moved, which exported surfaces appeared,
which existing seams were extended.

Emit `None.` when K = 1 (no predecessor).

## Patterns established

A short bulleted list of conventions / helpers / patterns prior sub-
tickets introduced that this K (and successors) should reuse rather than
re-derive. Examples worth noting: a new fake added to a test package,
a config field name a prior K picked, a helper function exported for
downstream sub-tickets to call.

Emit `None.` when K = 1, or when no reusable patterns were established.

## Plan adjustments

A short bulleted list of any drift between the master plan and what
actually shipped in predecessor sub-tickets — e.g., "the disposition
table grew a 6th bucket because of a State field discovered late." Each
bullet says what the master plan said, what shipped instead, and a one-
line reason.

Emit `None.` when K = 1, or when prior sub-tickets implemented the
master plan faithfully.

## Gotchas

A short bulleted list of footguns this sub-ticket should know about:
flaky tests prior sub-tickets papered over, tooling quirks the
predecessor's review caught, ordering invariants the impl review caught
prior K on, sibling sub-tickets the work-agent must NOT start
implementing (sibling-scope creep is a structural impl-review-intent
blocker — name the sibling K and what it owns so the work-agent doesn't
drift into it). Each bullet should be actionable on impl-turn 1.

Emit `None.` only when there is genuinely nothing non-obvious to flag
(rare — at minimum, K ≥ 2 should name the sibling sub-tickets that come
after this one so the work-agent knows where their slice ends).
````

## Variables available to you

- PR number: `{{PR_NUMBER}}`
- PR title: `{{PR_TITLE}}`
- Iteration: `{{ITERATION}}`
- Branch: `{{HEAD_REF}}`
- Review directory (persona JSON + consolidated.json, K ≥ 2 only):
  `{{REVIEW_DIR}}`
- Sub-ticket index entering impl: `{{SUB_TICKET_INDEX}}`
- Total sub-tickets in the chain: `{{SUB_TICKET_TOTAL}}`

## Closing check

Before you return, verify the draft is under the token budget, the
sections are in order, "Your slice" is concrete (cites the partition
line, not a paraphrase), and any redaction rules from your prior turn
(no secrets, no token-shaped literals, no verbatim finding messages) are
respected. Then write the file and reply with a single line:
`epic-sub-ticket-brief.md written (<N> bytes)`.
