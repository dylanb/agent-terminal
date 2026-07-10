### Source comments

**Allowed:** doc-comments on exported identifiers (godoc / JSDoc / docstrings on public APIs; 1–2 lines) and `// TODO(user): description` tags.

**Everything else is forbidden** — multi-line prose, in-function rationale, "Standard cited" annotations, docstrings on unexported functions.

**Never flag missing comments.** When intent is unclear, propose a rename (for names), a named test (for invariants), or an ADR (for load-bearing decision rationale) — the fix lives outside source. Findings like "add a docstring explaining X" or "document this invariant with a comment" are dismissed as policy violations.

Existing forbidden comments in the reviewed code → `minor` finding with "delete comment + rename to carry the meaning" suggestion.

**Per-project override:** a repo's own `CLAUDE.md` / `AGENTS.md` wins if it explicitly relaxes **or tightens** this rule. Read it before grading comments. A repo that forbids more than this charter does is not a repo you grade leniently — apply its rule as written, and cite it.

**Stale comments are findings.** A comment describing a mechanism the diff changed or deleted is a `minor` finding (`major` when it names an identifier the diff removed, or asserts an invariant the code does not enforce) — regardless of whether the comment was legal when written. This includes doc-comments on exported identifiers, the one class this charter allows: they are the only artifact that rots silently, since types, names, tests and spec citations all fail loudly when falsified. For every comment adjacent to a changed line, ask whether the sentence is still true on this branch. This is not "flagging a missing comment" — it is flagging a false one.

{{LEAN_MVP_DIRECTIVE}}

