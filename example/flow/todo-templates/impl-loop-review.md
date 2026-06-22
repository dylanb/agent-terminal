# Impl-loop review

Checklist instantiated for the `implement` step (§21.2). Each top-level list item below becomes one
active todo; this heading and any prose are ignored by the instantiator.

- Is the implementation too complicated for what it needs to achieve?
- Are the new modules implemented with simple, clean interfaces that do not leak information so that the implementation could change and the callers and tests would not have to change?
- Are the modified modules still clean? Has any change been made that now makes a refactor necessary?
- Does the implementation meet all the repository standards?
- Has the implementation introduced anything that should become a repository standard?
