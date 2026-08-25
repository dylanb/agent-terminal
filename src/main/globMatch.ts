// A pure, dependency-free glob matcher for repo-relative POSIX paths. Pure and node-free, so it could move
// to src/shared/ if a renderer consumer ever appears; today only the main-process frozen-tests detection
// (§28.5.1) uses it, so it lives here (placement follows consumption, like confinedPath.ts).
//
// Supported subset, matched against a `/`-separated path: `*` matches any run (incl. empty) of non-`/`
// characters within one segment; `?` matches exactly one non-`/` character; `**` — only as a WHOLE segment —
// matches zero or more segments. Every other character, including `[`, `]`, and a leading `/`, is literal.
// The subset is deliberate: test_globs are the small, well-known shapes (`tests/**/*.test.ts`, `**/*_test.go`),
// and a narrow, total grammar is what keeps the matcher regex-free.
//
// Regex-free by construction: matched with a bottom-up dynamic-programming recurrence over path segments, so
// an adversarial pattern from an untrusted repo's loop-capabilities.yaml cannot trigger catastrophic
// backtracking (CWE-1333). The recurrence is polynomial — O(|pattern segments| × |path segments|) segment
// comparisons, each a bounded two-pointer wildcard match, with no recursion — and is rolled to a single row
// so storage is O(|path segments|), not the full table. The path comes from untrusted `git diff` output, so
// the aggregate comparison count is capped before matching (CWE-400): a crafted deep path is rejected rather
// than allowed to hang/OOM the main process.

// The most character comparisons any one match may perform. The total segmentMatch work is bounded by
// (Σ pattern-segment lengths)·(Σ path-segment lengths) ≈ |pattern|·|path| CHARACTERS — counting SEGMENTS would
// miss a single huge segment (a 1 MiB path component vs a 1024-char wildcard is 1×1 segments but ~10⁹ chars).
// Real globs/paths multiply to < 10⁵; this cap (10⁶) only rejects a crafted path, and bounds the work.
const MAX_GLOB_MATCH_CHARS = 1_000_000;

/** Whether `pattern` matches the whole repo-relative path `path`. Throws `RangeError` when the pattern×path
 *  character product exceeds the work budget (an untrusted-input resource-exhaustion guard, CWE-400). */
export function globMatch(pattern: string, path: string): boolean {
  if (pattern.length * path.length > MAX_GLOB_MATCH_CHARS) {
    throw new RangeError(`glob match budget exceeded: ${pattern.length}×${path.length} character comparisons`);
  }
  const p = pattern.split('/');
  const t = path.split('/');
  const n = p.length;
  const m = t.length;

  // `next[j]` = the pattern suffix p[i+1..] matches the path suffix t[j..]; `cur[j]` = the same for p[i..].
  // Rolling one pattern row at a time keeps storage O(m). Base (pattern exhausted): only a fully consumed
  // path (j=m) matches; path exhausted with pattern left matches only if every remaining segment is `**`.
  let next = new Array<boolean>(m + 1).fill(false);
  next[m] = true;
  for (let i = n - 1; i >= 0; i--) {
    const cur = new Array<boolean>(m + 1).fill(false);
    cur[m] = p[i] === '**' && next[m];
    for (let j = m - 1; j >= 0; j--) {
      cur[j] =
        p[i] === '**'
          ? next[j] /* ** matches zero segments here */ || cur[j + 1] /* … or consumes t[j] */
          : segmentMatch(p[i], t[j]) && next[j + 1];
    }
    next = cur;
  }
  return next[0];
}

/** Whether `path` matches any of `patterns` (the empty list matches nothing). */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globMatch(pattern, path));
}

/** Match one path segment against one pattern segment where `*` is any run of characters and `?` is one.
 *  Iterative two-pointer with a single backtrack mark — O(|pat| × |seg|) worst case, never exponential. */
function segmentMatch(pat: string, seg: string): boolean {
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < seg.length) {
    if (pi < pat.length && (pat[pi] === seg[si] || pat[pi] === '?')) {
      pi++;
      si++;
    } else if (pi < pat.length && pat[pi] === '*') {
      star = pi;
      mark = si;
      pi++;
    } else if (star !== -1) {
      pi = star + 1;
      mark++;
      si = mark;
    } else {
      return false;
    }
  }
  while (pi < pat.length && pat[pi] === '*') pi++;
  return pi === pat.length;
}
