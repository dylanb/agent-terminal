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
// Regex-free by construction: matched with a bottom-up dynamic-programming table over path segments, so an
// adversarial pattern from an untrusted repo's loop-capabilities.yaml cannot trigger catastrophic
// backtracking (CWE-1333). The matcher is polynomial — O(|pattern segments| × |path segments|) segment
// comparisons, each a bounded two-pointer wildcard match — with no recursion.

/** Whether `pattern` matches the whole repo-relative path `path`. */
export function globMatch(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const t = path.split('/');
  const n = p.length;
  const m = t.length;

  // dp[i][j] = the pattern suffix p[i..] matches the path suffix t[j..].
  const dp: boolean[][] = Array.from({ length: n + 1 }, () => new Array<boolean>(m + 1).fill(false));
  dp[n][m] = true;
  // Pattern exhausted but path remains → no match (dp[n][j<m] stays false). Path exhausted but pattern
  // remains matches only if every remaining pattern segment is `**` (each may match zero segments).
  for (let i = n - 1; i >= 0; i--) dp[i][m] = p[i] === '**' && dp[i + 1][m];

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        p[i] === '**'
          ? dp[i + 1][j] /* ** matches zero segments here */ || dp[i][j + 1] /* … or consumes t[j] */
          : segmentMatch(p[i], t[j]) && dp[i + 1][j + 1];
    }
  }
  return dp[0][0];
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
