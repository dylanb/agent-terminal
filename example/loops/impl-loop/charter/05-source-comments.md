### Source comments

**Allowed:** doc-comments on exported identifiers (godoc / JSDoc / docstrings on public APIs; 1–2 lines) and `// TODO(user): description` tags.

**Everything else is forbidden** — multi-line prose, in-function rationale, "Standard cited" annotations, docstrings on unexported functions.

**Never flag missing comments.** When intent is unclear, propose a rename (for names), a named test (for invariants), or an ADR (for load-bearing decision rationale) — the fix lives outside source. Findings like "add a docstring explaining X" or "document this invariant with a comment" are dismissed as policy violations.

Existing forbidden comments in the reviewed code → `minor` finding with "delete comment + rename to carry the meaning" suggestion.

**Per-project override:** a repo's own `CLAUDE.md` / `AGENTS.md` wins if it explicitly relaxes this rule.

{{LEAN_MVP_DIRECTIVE}}

