/** The errno codes this codebase branches on. A closed union, not `string`: every caller selects
 *  swallow-vs-rethrow off this value, so a code that is merely *spelled wrong* would compile, never match,
 *  and silently convert a handled failure into an escaping one. Widen deliberately.
 *  https://man7.org/linux/man-pages/man3/errno.3.html */
export type ErrnoCode = 'ENOENT' | 'EEXIST' | 'EACCES' | 'EPERM' | 'EISDIR' | 'ENOTDIR' | 'ELOOP';

/** True when the caught value is an errno error carrying exactly `code`. Narrows `unknown` rather than
 *  casting it, so a thrown non-Error fails closed (CLAUDE.md: a caught value is `unknown`, never an `Error`). */
export function isErrno(e: unknown, code: ErrnoCode): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}
