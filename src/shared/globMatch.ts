// §28.5.1 — a regex-free glob matcher for repo-relative POSIX paths, AND the single definition of its
// supported grammar. Both consumers live off this one module (shared-semantics, #105): the frozen-tests
// detector matches with globMatch, and the loop-capabilities parser rejects unsupported syntax with
// unsupportedGlobReason — so what the matcher honors and what the validator rejects cannot drift apart.
// Regex-free + work-capped because both the pattern and the path are untrusted (CWE-1333/400).

// The most character comparisons any one match may perform. The total segmentMatch work is bounded by
// (Σ pattern-segment lengths)·(Σ path-segment lengths) ≈ |pattern|·|path| CHARACTERS — counting SEGMENTS would
// miss a single huge segment (a 1 MiB path component vs a 1024-char wildcard is 1×1 segments but ~10⁹ chars).
// Real globs/paths multiply to < 10⁵; this cap (10⁶) only rejects a crafted path, and bounds the work.
const MAX_GLOB_MATCH_CHARS = 1_000_000;

/** Why `glob` uses syntax this matcher does NOT honor (so it would silently match nothing — a fail-away), or
 *  null when it is within the supported grammar (`*`, `?`, whole-segment `**`). The one grammar definition the
 *  loop-capabilities parser rejects against; keeping it here beside globMatch is what prevents the two drifting. */
export function unsupportedGlobReason(glob: string): string | null {
  if (glob.includes('\0')) return 'contains a NUL byte; a git path never does, so it could never match';
  if (glob.startsWith('!')) {
    return 'uses leading-negation syntax, which is literal here; only *, ?, and whole-segment ** are honored';
  }
  if (/[{}()[\]|]/.test(glob)) {
    return 'uses unsupported glob syntax (braces, parens, brackets, or |); only *, ?, and whole-segment ** are honored';
  }
  for (const segment of glob.split('/')) {
    // git diff paths are repo-relative and normalized, so an empty segment (leading/trailing/doubled `/`) or a
    // `.`/`..` segment can never appear — such a glob matches nothing (fail-away).
    if (segment === '' || segment === '.' || segment === '..') {
      return "has an empty or '.'/'..' path segment; git paths are repo-relative and normalized, so it can never match";
    }
    if (segment.includes('**') && segment !== '**') {
      return 'uses ** inside a segment; ** is honored only as a whole path segment';
    }
  }
  return null;
}

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
 *  Iterated over CODE POINTS (Array.from), so `?` matches one whole non-BMP character, not half a surrogate
 *  pair. Two-pointer with a single backtrack mark — O(|pat| × |seg|) worst case, never exponential. */
function segmentMatch(patStr: string, segStr: string): boolean {
  const pat = Array.from(patStr);
  const seg = Array.from(segStr);
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
