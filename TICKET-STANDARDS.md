# TICKET-STANDARDS.md

The full authoring contract a ticket must satisfy before the `agent-loop/ready` label goes on. `CLAUDE.md`
carries the summary; this file is the authority — cite its section (e.g. "TICKET-STANDARDS.md § Writing
rules") rather than re-arguing.

Tickets are GitHub issues. A ticket is **agent-loop-ready** only when a human applies the **`agent-loop/ready`** label — the single "pickable now" signal (`agent-loop available` lists them; `agent-loop pickup <n>` assigns it, strips the label, and opens a draft PR that `closes #<n>`). Do not add `agent-loop/ready` yourself; it means *a human has vetted the ticket against everything below*.

The issue **body is the intent contract** — every loop turn is bound to the issue, and the work agent and every persona reviewer grade against its title, body and comments. Vague body → vague plan and reviews.

## Required content

Every ready ticket MUST contain:

1. **Title** — a crisp imperative (`Persist flow inputs across steps`), not a topic.
2. **Problem / context** — what's wrong or missing and why it matters. Cite the spec: `terminal-web-ui-spec.md §n` (the spec wins; if the ticket diverges, say so and add a changelog entry).
3. **Scope** — the concrete change to make, described as outcomes.
4. **Non-goals** — what this ticket explicitly does *not* do, so reviewers don't grade against absent work.
5. **Acceptance criteria** — see the AC rule below. This is what `review-intent` grades "done" against; without it the loop cannot catch an incomplete feature.
6. **Affected contracts** — if the change alters an external contract, say so and describe the observable contract *behavior*, pointing to `src/shared/ipc.ts` as where the typed contract lives. State "no contract change" when none. (Do not prescribe channel/payload names — that's an implementation decision.)
7. **Standards that apply** — by reference only: link the governing docs (TDD/RED-first, `UI-STANDARDS.md`, the tracer-bullet rule, relevant `§n`) so reviewers can cite them.

## Writing rules

These are non-negotiable for every ticket:

- **Acceptance criteria are measurable outcomes ONLY** — observable behaviors phrased so each becomes a test (user does X → observes Y). The sole exception is a ticket **inherently technical in nature** (support for a technical standard, an API implementation, a specific algorithm, and the like), which may state technical criteria directly.
- **Nothing that can drift.** A ticket MUST NOT contain anything that could change under normal activity — merging another branch, implementing the ticket itself, or making a reasonable implementation decision. No line numbers, current counts, "the function below," or any other detail that goes stale the moment work begins.
- **No implementation.** A ticket MUST NOT contain statements in the realm of *how* to build it. Point to the relevant repository standards **by reference only**; never inline the approach.
- **Unambiguous.** Avoid statements open to more than one reading. Write one clear meaning per statement; add clarifying language only where genuinely necessary.
- **No internal conflict.** A ticket MUST NOT contradict itself or any existing standard — **unless** the conflict is an explicit user instruction, in which case the ticket MUST state clearly that it is an explicit user instruction (and why it overrides the standard).

## Tracer-bullet tickets (§24.2 backlog)

A §24.2 ticket MUST name the three things the tracer-bullet rule requires (see [`TRACER-BULLET.md`](TRACER-BULLET.md)): the **user-visible action** that fires the slice, the **observable result in the UI**, and the **e2e that proves it**. A ticket missing any of the three is not ready.

## Ready checklist

All must hold before the `agent-loop/ready` label goes on:

- [ ] Title is an imperative; body states problem, scope, **non-goals**.
- [ ] Acceptance criteria are measurable outcomes (or justified technical criteria).
- [ ] No drift-prone detail; no implementation (standards by reference only).
- [ ] Every statement is unambiguous; no internal or standards conflict (explicit user overrides labeled as such).
- [ ] Affected contracts described by behavior (or "none"); §24.2 work names action + result + e2e.
