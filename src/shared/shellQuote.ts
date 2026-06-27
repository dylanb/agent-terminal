// The one shell-quoting primitive shared by main and renderer (CLAUDE.md shared-semantics rule):
// any value placed into shell text — a generated script, a PATH block, a pasted path — is quoted here,
// never by a hand-rolled copy that could drift from this one.

/** Wrap a value as one POSIX shell single-quoted literal so every embedded metacharacter is data, not
 *  syntax (CWE-78). Lossless: it never deletes characters — control-char stripping or other
 *  paste-safety sanitization is a separate concern the caller applies before quoting. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
