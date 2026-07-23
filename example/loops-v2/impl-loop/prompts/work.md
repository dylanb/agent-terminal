# impl-loop — work turn

Implement the approved plan with the smallest correct change, red→green→refactor per `CLAUDE.md`.
Every acceptance criterion in the linked issue gets a failing test first, then the minimum code to
pass it. Commit the completed implementation and its tests; the orchestrator supplies the turn-done
signal, so do not create a synthetic output artifact.
