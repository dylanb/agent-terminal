// §26.5/§26.13 L6 — the reviewer fan-out skip-optimization. A persona that reviewed CLEAN on the
// immediately prior iteration AND whose per-phase footprint has not changed is pruned from the next
// fan-out (its last-clean review is reused). The footprint is the plan.md digest in the plan phase and
// the reviewed file set in the impl phase (§26.5). Pure so the orchestrator's roster-narrowing glue is
// driven by a tested decision.

/** One persona's persisted skip footprint (§26.6 `persona_state` entry). `lastSeenPlanDigest` is used in
 *  the plan phase, `lastSeenFiles` in the impl phase; the unused one for a phase is the empty default. */
export interface PersonaStateEntry {
  lastCleanIter: number;
  lastSeenPlanDigest: string;
  lastSeenFiles: string[];
}

/** The current iteration's footprint the fan-out compares against each persona's stored one. */
export type Footprint = { kind: 'plan'; digest: string } | { kind: 'impl'; files: string[] };

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

function footprintUnchanged(entry: PersonaStateEntry, fp: Footprint): boolean {
  return fp.kind === 'plan' ? entry.lastSeenPlanDigest === fp.digest : setEqual(entry.lastSeenFiles, fp.files);
}

/** Split the roster into the personas to re-review (`active`) and the ones to prune (`pruned`) for
 *  `iteration` (§26.5). A persona is pruned iff it was clean on `iteration-1` and its stored footprint
 *  matches the current one. `active` preserves the roster order. */
export function prunablePersonas(
  roster: string[],
  state: Record<string, PersonaStateEntry>,
  iteration: number,
  fp: Footprint,
): { active: string[]; pruned: string[] } {
  const isPrunable = (persona: string): boolean => {
    const entry = state[persona];
    return entry !== undefined && entry.lastCleanIter === iteration - 1 && footprintUnchanged(entry, fp);
  };
  return { active: roster.filter((p) => !isPrunable(p)), pruned: roster.filter(isPrunable) };
}

/** Fold this iteration's clean personas into `persona_state` (§26.5): each clean persona's entry is
 *  (re)written with `lastCleanIter = iteration` and the current footprint; every other prior entry is
 *  preserved unchanged (a non-clean persona keeps its stale last-clean footprint, so it is not pruned). */
export function recordCleanPersonas(
  prior: Record<string, PersonaStateEntry>,
  cleanPersonas: string[],
  iteration: number,
  fp: Footprint,
): Record<string, PersonaStateEntry> {
  const next: Record<string, PersonaStateEntry> = { ...prior };
  for (const persona of cleanPersonas) {
    next[persona] = {
      lastCleanIter: iteration,
      lastSeenPlanDigest: fp.kind === 'plan' ? fp.digest : (prior[persona]?.lastSeenPlanDigest ?? ''),
      lastSeenFiles: fp.kind === 'impl' ? fp.files : (prior[persona]?.lastSeenFiles ?? []),
    };
  }
  return next;
}
