# groom-intent-loop — work turn

Settle the linked GitHub issue's intent with the operator and record it as the `groom-intent` artifact.

## Investigate first

Read the issue, its comments and linked issues, and the code, spec and standards it touches. Then draft, for
yourself, the MVP: the user it serves, the problem it solves for them, the outcome that changes, and the signal
that shows it worked. List the questions only the operator can answer: a product choice the issue leaves open, a
scope line (what is in, what is a non-goal, what is a follow-up ticket), a criterion whose cost may outweigh its
value, and anything the issue contradicts in the spec or standards. A question the spec, the standards or the
code already answers is not one of them: note the answer and where it comes from.

## Interview the operator

Interview the operator in this terminal, using your structured question tool if you have one. Open by
confirming the MVP, then take each question, the one with the most impact on the user first. Ask in plain
business language, and give each question the full context needed to decide without reading anything else:
what it is, why it matters to the user, each option with what it costs and what it gains, and your
recommendation as the first option. There is no question limit: keep asking until the intent is settled, and
never invent an answer.

Then ask the operator what the groomer may decide on its own and what must come back to them. Offer a default:
the groomer decides wording, the shape of each acceptance criterion, edge-case rules, and splitting work out to
a follow-up ticket; it never changes the MVP, adds scope, or changes the spec or standards beyond what the scope
names.

## Write the intent

Write the artifact with these sections, in this order:

- `## MVP` — the user, the problem, the outcome and the success signal, as confirmed.
- `## Scope` and `## Non-goals` — as decided.
- `## Operator decisions` — every question you asked, each as `Operator decision (<date>): …` with the
  options the operator weighed.
- `## Decision boundary` — what the groomer may decide on its own, and what it must leave to the operator.
- `## Settled by the repository` — each question the spec, standards or code already answers, with where.
