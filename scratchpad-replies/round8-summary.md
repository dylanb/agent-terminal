**Round 8 review — all nine suppressed findings addressed:**

**Two genuine defects (fixed RED-first):**
- **`globMatch.ts:68` — non-BMP `?`/`*`** (55b3b82): `segmentMatch` indexed UTF-16 units, so `?` matched only half a surrogate pair and `globMatch('tests/?.ts','tests/😀.ts')` was false — a configured test path silently missed. Now iterates over code points (`Array.from`); Unicode regression added.
- **`loopCompletionPredicates.ts:19` — seam success coverage** (50856fd): the seam test covered only the absent arm (a stub returning `{ok:false}` would pass). Added a success case observing `changedTestPaths` surfacing the matched changed path.

**Test/export cleanup:**
- **`gitHardening.test.ts:13`** (50856fd): removed the last implementation-coupled argv pin and un-exported `bootstrapProtectedArgs` (its only importer was that test — it's now module-private). Single-source is enforced by the composition itself; behavior is covered in `bootstrapPorts.test.ts`.

**Six comment-discipline trims** (3cb4b74) — `globMatch`, `frozenTests`, `loopCapabilities`, `loopCompletionPredicates`, `phaseOutcome`, `gitHardening` headers: dropped the spec-paraphrase and mechanism play-by-play per CODE-STANDARDS.md:276-294, keeping the § citation plus only what the code can't express (the security invariants — fail-toward-firing, the RCE levers a `-c` override neutralizes, confinement, regex-free/CWE budgets — the shared-semantics single-source coupling, and the injection-seam rationale).
