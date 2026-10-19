---
name: agent-terminal-loops
description: Run an agent-terminal loop (groom, plan, red, green, refactor, integration-slice, …) by hand in Codex — its work step, its reviewer round, and the judgement of that round. Use when asked to run a loop's reviewers or review personas, to "run the integration-slice reviewers", to review work the way an agent-terminal loop would, or to find where the agent-terminal loop definitions and charters live.
---

# agent-terminal loops

agent-terminal's **Install examples** action put everything this skill uses in your Codex home, written
`<codex home>` below: `$CODEX_HOME` when that is set, else `~/.codex`. Use these installed files. Do not go
looking for loop definitions or charters anywhere else, such as the Claude config directory, and do not
rebuild them from memory.

## Where things are

- **Loop definitions:** `<codex home>/loops-v2/<flow>/<loop>/<loop>.yaml`, for example
  `loops-v2/feature-dev-v2/integration-slice-loop/integration-slice-loop.yaml`. A definition names its own
  files, as paths relative to its directory: its work recipe in `work.recipe`, its judging recipe in
  `consolidator.recipe` when it has review rounds, its standing instructions in `brief` when it has them, and
  each reviewer's charter in `reviewers[].charter`. A definition with a `work.goal` reviews its own work.
- **Reviewer agents:** one custom agent per reviewer, in `<codex home>/agents/`. Its name is the loop
  name and the persona name joined by `__`, with every `-` written as `_`. The `impl-review-reliability`
  reviewer of `integration-slice-loop`, for example, is `integration_slice_loop__impl_review_reliability`.
  Its instructions already are its charter.

If a loop, a charter, or a reviewer agent you need is missing, stop and tell the user to run **Install
examples** in agent-terminal again and then restart Codex, because Codex loads agents only when a session
starts. Do not stand in for a missing piece with something else.

## Running a loop

1. **Read the definition.** Open the loop's `<loop>.yaml`. Its `reviewers:` list is the round's roster,
   one entry per `persona`.
2. **Work.** If the definition has a brief, follow it for the whole loop, including every fix in step 3.
   Then do what its work recipe asks. A definition with no `consolidator` has no review rounds: the loop
   ends here. One with a `work.goal` runs step 3 itself, as its recipe says, and ends once the goal holds.
3. **Review and fix.** Spawn every reviewer on the roster in parallel as its installed agent, by its exact
   name. Never spawn a default or general agent in place of a reviewer's own. Give every reviewer the
   hand-off below word for word, with your values in place of the `<…>` placeholders, so what it receives
   never depends on how you phrase it. Add nothing to it.

   Open with the issue the work is for:

   ```text
   Review the work for GitHub issue #<n>. Read the issue and its comments with `gh issue view <n> --comments`.
   ```

   or, when there is no issue:

   ```text
   Review this loop's work.
   ```

   Then say what it grades. When the loop changed code:

   ```text
   The code and tests under review are this branch's change: its commits since it left the repository's
   default branch, plus any uncommitted changes. See them with git: `git log`, `git status`, and `git diff HEAD`.
   ```

   or, when the loop produced a file, name that file:

   ```text
   Grade <artifact>, the artifact this loop produced, not the issue body on GitHub. The issue is the
   intent the artifact must honour, and it can still hold text the artifact has since fixed.
   ```

   When you run the loop for one impl-slice of the plan:

   ```text
   This round covers impl-slice <slice> of the plan only; work that belongs to another slice is not under review.
   ```

   When the step carried input documents, one line for each:

   ```text
   Grade it against these documents, beside the ticket:
     - <input-id>: <input-path>
   ```

   Always end with:

   ```text
   FLOW DOCUMENTS — this work's flow documents (the groomed ticket, the plan, the RED/GREEN phase results) live
   only under `.agent-terminal/loop/artifacts/`.
   A file of that kind found elsewhere in the repository is not one of this work's flow documents, so never read
   it as one; it is still work when the ticket names it as something to change.
   The repository's standards and configuration are read where they live.
   Do not change any file: report your findings, and the fixer makes every change.
   Judge each finding against this definition of a NIT, the one the fixer applies too:

   A change is a NIT if it meets ALL of the following criteria:

   1. **Behavioral Equivalence:** It produces identical runtime output, side effects, and control flow across all valid, invalid, and edge-case inputs.
   2. **Zero Performance Impact:** It has no material impact on execution speed, memory footprint, I/O, concurrency, or resource consumption.
   3. **Zero Future Debt:**
      - It does not prevent future extensibility, refactoring, or API evolution.
      - It does not violate any enforceable project-wide linting, formatting, typing, or CI/CD rules (if CI passes without it, it qualifies).
      - It does not conceal logic in a way that makes bug diagnosis significantly harder.
   4. **Preference-Driven:** It is rooted entirely in personal preference, alternative idiomatic phrasing, or subjective aesthetics where the existing implementation is already clear and standard.

   **Classification Test (the "Safe-to-Ignore" Rule).** Evaluate the change against this question: "If this pull request is merged without this change, could any test fail, bug arise, security vulnerability open, system resource degrade, or future contributor be materially misled or blocked?"

   - If the answer is "No" to all: the change is a NIT → Status: OPTIONAL / DO NOT IMPLEMENT.
   - If the answer is "Yes" or "Maybe" to any: the change is NOT A NIT.

   You may label a finding a NIT; the fixer weighs that label and makes the call.
   The PR description is not under review: raise no finding about it.
   Return each finding with its file:line, the issue, its concrete consequence, and the fix. Do not rate severity.
   If you find nothing, return exactly: no findings
   ```

   Do not hand it a charter, a diff, a prior review, or other reviewers' findings: it pulls what it needs
   with its tools. Take every finding into your own context, then fix or dismiss each by the same criterion
   the engine gives its fixer:

   ```fix-criterion

   NITs — the reviewers and you judge findings by this one definition of a NIT:

   A change is a NIT if it meets ALL of the following criteria:

   1. **Behavioral Equivalence:** It produces identical runtime output, side effects, and control flow across all valid, invalid, and edge-case inputs.
   2. **Zero Performance Impact:** It has no material impact on execution speed, memory footprint, I/O, concurrency, or resource consumption.
   3. **Zero Future Debt:**
      - It does not prevent future extensibility, refactoring, or API evolution.
      - It does not violate any enforceable project-wide linting, formatting, typing, or CI/CD rules (if CI passes without it, it qualifies).
      - It does not conceal logic in a way that makes bug diagnosis significantly harder.
   4. **Preference-Driven:** It is rooted entirely in personal preference, alternative idiomatic phrasing, or subjective aesthetics where the existing implementation is already clear and standard.

   **Classification Test (the "Safe-to-Ignore" Rule).** Evaluate the change against this question: "If this pull request is merged without this change, could any test fail, bug arise, security vulnerability open, system resource degrade, or future contributor be materially misled or blocked?"

   - If the answer is "No" to all: the change is a NIT → Status: OPTIONAL / DO NOT IMPLEMENT.
   - If the answer is "Yes" or "Maybe" to any: the change is NOT A NIT.

   Judge against the NIT definition each valid finding that is not out of scope for a reason other than polish
   deferral, and weigh any NIT label the reviewer gave it; the call is yours. A NIT is never implemented: record
   it as `dismissed — nit` with a reason saying why it passes the Safe-to-Ignore test, never `fixed`.
   Any finding about the PR description, whatever its content, is `dismissed — out of scope`.

   What counts as documentation:

   A change is documentation when it alters only prose documentation files, such as Markdown, the spec and
   READMEs, or comments in code files, leaving every other token of the code unchanged. These are not
   documentation: the loop's own flow documents under `.agent-terminal/loop/artifacts/` (the groomed ticket, the
   plan, phase results), because in plan and groom loops they are the work under review; configuration, data and
   build files; prompt, recipe and charter files an agent executes; and string literals, identifiers or anything
   else the program reads at runtime. When unsure, the fix is `fixed`.

   Record a fix whose changes are all documentation as `fixed — documentation`, and any other fix as `fixed`.
   When every change the fixes made is documentation or in another non-code file, run only those of the
   repository's required tests that check such files, and none if the repository has none. The required tests
   are all the tests the repository requires to run and pass before the flow moves to its next phase; which of
   them check documentation or non-code files is for the repository to define.

   Dismiss what is out of scope or invalid; escalate to `needs a human` only what the loop is not entitled to decide.

   Test-support code — a fake, stand-in, or double of a real tool, and the fixtures and helpers around it —
   exists to serve the tests that use it. A finding that it differs from the real tool, or that a branch of it
   has no test of its own, changes an observable outcome only when a test the ticket needs relies on that
   behaviour, so the gap would let that test pass over broken code or fail over correct code. Otherwise it is
   `dismissed — invalid`, never `fixed`: a double can always be made more faithful, so fixing such gaps never
   runs out. A test written later that relies on the behaviour is reviewed in its own round.
   ```

4. **Judge the round.** Follow the definition's judging recipe. It decides between clean, another round with a
   smaller roster, and stopping for a human, by this rule. A round whose issues are all dismissed or
   `fixed — documentation` is `clean`: it changed nothing except documentation, and `dismissed — nit` counts
   as a dismissal. A round with any `fixed` issue is `another round`, however many NIT dismissals and
   documentation fixes it also records. A round that records a `needs a human` issue is judged by the
   `stop for a human` rule. For another round, go back to step 3 with the roster it chose.

## Saying how you know

When asked how you found a file, chose a roster, or decided something, say only what you can check: this
skill, a file you read, or a command you ran. If the reason has since been lost from your context, say so.
Do not reconstruct a plausible account.
