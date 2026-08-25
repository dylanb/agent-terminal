**Round 4 review — both suppressed findings fixed in a18d678:**

- **`loopCapabilities.ts:68` (glob validation):** `requireSupportedGlob` now also rejects an empty segment (leading/trailing/doubled `/`) and `.`/`..` segments — all unmatchable against git's normalized, repo-relative diff output, so all would fail-away exactly like the brace/char-class cases. Parser tests cover `/tests/**`, `tests/`, `tests//a`, `tests/./a`, `tests/../a`.
- **`loopCapabilities.ts:144` (raceable size cap):** the read is now bounded at `MAX+1` bytes via a `readSync` loop instead of `readFileSync`'s read-to-EOF, so a file appended-to after the `fstat` can't drive an unbounded read past the 512 KiB cap (CWE-400). The over-/at-cap regression tests pin the bounded gate (verified: they fail when the gate is neutered).

Re-requesting review.
