/** The errno codes this codebase branches on. A closed union, not `string`: every caller selects
 *  swallow-vs-rethrow off this value, so a code that is merely *spelled wrong* would compile, never match,
 *  and silently convert a handled failure into an escaping one. Widen it when a caller genuinely needs a new
 *  code — an unused member is a claim about the code that is not true.
 *  https://man7.org/linux/man-pages/man3/errno.3.html */
export type ErrnoCode = 'ENOENT' | 'EEXIST' | 'ELOOP' | 'ESRCH' | 'EPERM' | 'ECONNREFUSED' | 'EACCES';

/** True when the caught value is an errno error carrying exactly `code`. Narrows `unknown` rather than
 *  casting it, so a thrown non-Error fails closed (CLAUDE.md: a caught value is `unknown`, never an `Error`). */
export function isErrno(e: unknown, code: ErrnoCode): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}

/** A caught value's message. The same rule as `isErrno`: a thrown string, or any non-`Error` a dependency
 *  throws, still has to explain itself — `(e as Error).message` yields `undefined` and swallows it. */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
