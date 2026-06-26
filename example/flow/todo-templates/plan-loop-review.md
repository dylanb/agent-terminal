# Plan-loop review

Checklist instantiated for the `plan` step (§21.2). Each top-level list item below becomes one
active todo; this heading and any prose are ignored by the instantiator.

- What is the content of the plan gate report?
- Is the plan too complicated for what it needs to achieve?
- Are there any areas that the plan overspecifies? If there are, tighten everything that may lead to churn if the implementation makes changes that are justifiable but unaligned with the specifics.
- Are there any tensions between the ticket and the plan that might cause the reviewers and the implementer to burn cycles disagreeing with each other? If so, propose how we could specify behavior so that the implementor can choose the right path and reviewers litigate based on outcomes and not implementation choices.
- Are there details or statements in the ticket that might be made no longer true by changes that the implementor makes, leading to review churn?
- Is there context or standard that would be helpful for the implementer that we should surface in the plan that is not surfaced? If so, reference — don't duplicate — the standards into the plan.
- Is there any context or standard missing that we should create in order to make the implementation more likely to succeed?
