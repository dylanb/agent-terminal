// One definition of "the same human-needed loop entry" (§24.2.3 T4), imported by both the
// OS-notification dedup (main) and the status bar's alert (renderer) so the two cannot drift. `repoKey`
// is nullable: the renderer's repo may not be seeded yet (§16.3).

export interface Occurrence {
  repoKey: string | null;
  status: string;
  iteration: number;
}

/** A null on either side never matches. */
export function sameOccurrence(a: Occurrence | null, b: Occurrence | null): boolean {
  return a !== null && b !== null && a.repoKey === b.repoKey && a.status === b.status && a.iteration === b.iteration;
}
