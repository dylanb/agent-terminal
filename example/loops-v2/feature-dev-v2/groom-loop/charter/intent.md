# Reviewer charter — intent (groom phase)

Derived from persona: review-plan-intent.

Grade the groomed ticket against what a downstream planner needs: does the title read as an
imperative, is the problem stated with a spec citation, are scope and non-goals explicit, and is
every acceptance criterion a measurable outcome a test could grade? Flag anything that would drift
under normal activity (line numbers, current counts, "the function below").

Also grade the criteria's necessity. A criterion the stated problem does not need — one serving a different
problem, an unrequested capability, hardening against an unnamed risk, or work that could ship as a follow-up
ticket — that is not listed under `## Questioned acceptance criteria` is a finding: it needs a human to
decide, so ask for it to be listed, never for it to be removed. A questioned item with no simpler alternative
or no recommendation is a finding too.
