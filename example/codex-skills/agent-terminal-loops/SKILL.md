---
name: agent-terminal-loops
description: Run an agent-terminal loop (groom, plan, red, green, refactor, integration-slice, …) by hand in Codex — its work step, its reviewer round, and the judgement of that round. Use when asked to run a loop's reviewers or review personas, to "run the integration-slice reviewers", to review work the way an agent-terminal loop would, or to find where the agent-terminal loop definitions and charters live.
---

# agent-terminal loops

agent-terminal's **Install examples** action put everything this skill uses in your Codex home
(`$CODEX_HOME`, else `~/.codex`). Use these installed files. Do not go looking for loop
definitions or charters anywhere else, such as the Claude config directory, and do not rebuild them
from memory.

## Where things are

- **Loop definitions:** `$CODEX_HOME/loops-v2/<flow>/<loop>/<loop>.yaml`, for example
  `loops-v2/feature-dev-v2/integration-slice-loop/integration-slice-loop.yaml`. Beside each definition are
  `charter/*.md` (one per reviewer) and `prompts/` (`work.md`, `consolidate.md`, and `brief.md` when the
  definition names a `brief`).
- **Reviewer agents:** one custom agent per reviewer, in `$CODEX_HOME/agents/`. Its name is the loop
  name and the persona name joined by `__`, with every `-` written as `_`. The `impl-review-reliability`
  reviewer of `integration-slice-loop`, for example, is `integration_slice_loop__impl_review_reliability`.
  Its instructions already are its charter.

If a loop, a charter, or a reviewer agent you need is missing, stop and tell the user to run **Install
examples** in agent-terminal again and then restart Codex, because Codex loads agents only when a session
starts. Do not stand in for a missing piece with something else.

## Running a loop

1. **Read the definition.** Open the loop's `<loop>.yaml`. Its `reviewers:` list is the round's roster,
   one entry per `persona`.
2. **Work.** If the definition names a `brief`, follow it for the whole loop, including every fix in step 3.
   Then do what `prompts/work.md` asks.
3. **Review and fix.** Spawn every reviewer on the roster in parallel as its installed agent, by its exact
   name. Never spawn a default or general agent in place of a reviewer's own. Give every reviewer the same
   hand-off and nothing else, so what it receives never depends on how you phrase it:
   - the issue number, and that it reads the issue with `gh issue view <n> --comments`;
   - the artifact it grades, if the loop produced a file (the issue is then the intent, not the subject);
     otherwise that the work is this branch's change, seen with `git log`, `git status` and `git diff HEAD`;
   - the paths of any inputs the step carried, to grade against beside the issue;
   - that it must not change any file, because you make every change;
   - that it returns each finding as its file:line, the issue, its concrete consequence and the fix, with
     no severity rating, or exactly `no findings`.

   Do not hand it a charter, a diff, a prior review, or other reviewers' findings: it pulls what it needs
   with its tools. Take every finding into your own context, then fix it or dismiss it with a reason. A
   finding only the user can settle is "needs a human".
4. **Judge the round.** Follow `prompts/consolidate.md`. It decides between clean, another round with a
   smaller roster, and stopping for a human. For another round, go back to step 3 with the roster it chose.

## Saying how you know

When asked how you found a file, chose a roster, or decided something, say only what you can check: this
skill, a file you read, or a command you ran. If the reason has since been lost from your context, say so.
Do not reconstruct a plausible account.
