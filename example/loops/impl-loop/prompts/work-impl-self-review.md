# Pre-review self-check — all-reviewer pass

## Your role for this pass

You just finished an impl iteration. **Before** the outer review fan-out runs, you are going to apply each of the eleven reviewer SKILLs to the PR — in this same session — and close every actionable finding they would raise. Your goal is for the outer fan-out to return clean on the first try.

The outer reviewers operate without a pre-injected diff and without seeing the plan. They review the PR using whatever read-only mechanism suits them — reading source files, inspecting git history, consulting PR metadata — with the ticket's acceptance criteria as the spec and the repository's standards as the grading rubric. **You operate the same way for this pass.** The plan is yours-as-the-work-agent to consult; the reviewers don't see it, so AC-vs-implementation gaps the plan happens to hide are the ones most likely to bite you on the outer pass.

## Why this pass exists

The outer review fan-out drip-feeds findings — 2–3 per round per persona even when 8–10 gaps are latent. Every gap the outer reviewers raise that you could have closed here is expensive: one needs-work round costs roughly $45–65 (eleven personas × prompt + output + consolidator). One $5 self-review pass that prevents one outer round is a good trade even when it finds nothing new.

## Your task

1. **Read the repo's standards first.** Open `CLAUDE.md`, `AGENTS.md` if present, files in the ADR directory, and `.claude/rules/*.md`. Apply them as the rule-of-first-resort; the injected SKILLs are supplementary. If the iteration's diff touches UI, also locate the repo's UI/a11y standards before self-reviewing — `impl-review-conventions` and `impl-review-accessibility` grade against them.

2. **Apply each reviewer SKILL to the PR, in turn.** Each of the eleven SKILLs is injected at the bottom of this prompt. For each:
   - Walk its Checks section against the PR.
   - For every check the PR fails, raise the finding mentally (you are NOT writing JSON).
   - **Close the finding** — fix the code, add the missing test, tighten the commit message, update the PR body, write the ADR. `blocker`/`major` always close. `minor` is judgment — close if the fix is one or two lines.

3. **Iterate until no SKILL raises an actionable finding.** Stop when:
   - All eleven SKILLs return zero `major`/`blocker` findings on a clean pass.
   - The new findings set ⊆ the prior pass's findings (oscillating — commit what you have and exit).
   - You've completed **3 inner passes**. Do not exceed 3; the outer fan-out is the backstop.

4. **Verify.** Run `make test` or the affected test subset; `make smoke-all` if the repo has one. Do not ship a red tree.

5. **Commit the closures** — amend your iter's final commit or add a follow-up `self-review: close pre-review findings` commit. Reviewers read tree state.

## Output contract

When you stop, print exactly one of these terminal lines as the last line of your response:

    SELF-REVIEW COMPLETE: <N> passes, <M> findings closed, <K> minor deferred

or

    SELF-REVIEW SKIPPED: <reason>

**Ignore the SKILLs' JSON output format sections below.** You are NOT writing `review-*.json`. You are using each SKILL's Checks + Standards + Finding-quality sections as a critique lens. The output of this pass is diff edits + commits + artifact updates, not verdict files.

## Continuous integration — current state

The orchestrator just polled CI for the commits you pushed this iter. A failing check that names a file you touched is exactly the kind of gap the outer `review-ci` reviewer will grade as a blocker next.

{{CI_SUMMARY}}

## Pay special attention to issues similar to these

The outer fan-out flagged these patterns on this PR's prior iterations. For every pattern below:

1. Confirm the specific instance cited is closed in your current tree.
2. **Find and close every OTHER instance of the same pattern** in your changed files — do not stop at the lines cited.
3. If no additional instances exist, state so explicitly.

{{PRIOR_FINDINGS}}

---

## Context you have

- iteration: {{ITERATION}}
- PR: #{{PR_NUMBER}}
- hard cap: 3 inner passes
