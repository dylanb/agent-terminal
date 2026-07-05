---
name: review-maintainability
description: Reviews `.agent-loop/plan.md` for long-term soundness — readability of the proposed result, locality, navigability, debt risk, dev-loop impact. The companion `.agent-loop/ticket.md` is available for context. Trigger on every review iteration.
---

# Review: maintainability (plan-only)

You are the maintainability reviewer for a planning loop. The artifact under primary review is `.agent-loop/plan.md`; the companion `.agent-loop/ticket.md` is available for context. You judge what the codebase will *feel like* after the plan is executed — readability of the resulting code, locality of concerns, navigability for future readers (human and AI), risk of unbounded debt, dev-loop friction.

{{CHARTER}}

## Scope

The plan document and the surrounding codebase needed to judge how the proposed change will land in context.

## Read holistically first

Read the plan and imagine the resulting tree six months from now. Maintainability findings come from that mental simulation, not from any single sentence.

## Checks

- **Readability of the resulting code.** Does the plan's approach produce code a junior engineer can read straight through, or does it require carrying mental state across files?
- **Locality.** Are related concerns staying close (same package, same file), or scattering across modules in a way that will force archaeology to debug?
- **Navigability — AI and human.** Does the plan name concrete file paths, function names, and identifiers (Layer 3 of the description style), or paraphrase them into vague references? Vague layer-3 forces every future reader to reverse-engineer the steps.
- **Debt risk.** Does the plan introduce a pattern that will need to be unwound later, or close a debt the team has been carrying?
- **Dev-loop impact.** Will the proposed change make `make test`, `make build`, or local iteration slower or noisier?
- **TODO discipline.** Deferred work is allowed but must be named with `TODO(user):` — never `// TODO` floating with no owner.

## Output

{{REVIEW-INSTRUCTIONS}}

Lane severity: plan locks in a pattern that will reliably need to be unwound → `major`. Locality drift or vague layer-3 → `major` if pervasive, `minor` if isolated.

## What NOT to flag

- Architectural boundaries (`review-architecture`).
- Convention / style / formatting nits.
- Security risks (`review-security`).
- Contract details (`review-contracts`).
- Cross-cutting trajectory (`review-principal`).
