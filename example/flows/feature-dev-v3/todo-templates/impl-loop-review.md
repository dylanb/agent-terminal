# Impl-loop review

Checklist instantiated for the `implement` step (§21.2). Each top-level list item below becomes one
active todo; this heading and any prose are ignored by the instantiator.

- What are the security vectors of the PR? Is there anything concerning that we should investigate further?
- Is the implementation too complicated for what it needs to achieve?
- Are the new modules implemented by the whole PR implemented with simple, clean interfaces that do not leak information so that the implementation could change and the callers and tests would not have to change?
- Are the interfaces of the modules modified by any of the changes in the entire PR still clean? Is a refactor of any of them necessary?
- Does the implementation meet all the repository standards?
- Has the implementation introduced anything that should become a repository standard?
- Is the implementation completely tested?
