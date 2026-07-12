// CLAUDE.md: a caught value is `unknown`, never an `Error`. One definition, so a cast cannot creep back in
// at the next filesystem callsite (it did: commit 0fe529b removed them once already).

/** True when the caught value is an errno error carrying exactly `code` (`'ENOENT'`, `'EACCES'`, …). */
export function isErrno(e: unknown, code: string): boolean {
  return e instanceof Error && 'code' in e && e.code === code;
}
