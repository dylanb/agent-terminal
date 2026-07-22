// The §27 per-repo loop area's layout, relative to the repo root. A leaf: no fs, no yaml, no dependency on
// the state writer — so the def parser, the engine and the state module can all derive locations from ONE
// definition without a parser depending on a persistence module.

/** The per-repo §27 loop area. */
export const APP_LOOP_DIR_SEGMENTS = ['.agent-terminal', 'loop'] as const;

/** The artifacts subtree (§27.10), disjoint from the run-state file, the round reports and the
 *  consolidator outputs. One definition for the def parser that confines bindings into it and for the
 *  repo-relative form the work prompt names. */
export const ARTIFACTS_SUBDIR = 'artifacts';
