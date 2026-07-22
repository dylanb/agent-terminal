// §27.10 — the chained-input vocabulary: what an upstream loop left at a declared input binding, and the
// partition of a step's declared bindings into what carries into its work turn and what did not resolve.
// One home, so the fs classifier, the prompt composer and the engine all name the same concept.

import type { ArtifactBinding } from './loopDefV2';

/** §27.10 */
export interface ChainedInput {
  id: string;
  rel: string;
}

/** §27.10 */
export type ChainedInputState = 'produced' | 'not-produced' | 'unreadable';

/** §27.10 */
export interface UnresolvedChainedInput {
  id: string;
  state: Exclude<ChainedInputState, 'produced'>;
}

/** §27.10 */
export interface ChainedInputResolution {
  carried: ChainedInput[];
  unresolved: UnresolvedChainedInput[];
}

/** §27.10 */
export function resolveChainedInputs(
  bindings: ArtifactBinding[],
  stateOf: (absPath: string) => ChainedInputState,
): ChainedInputResolution {
  const carried: ChainedInput[] = [];
  const unresolved: UnresolvedChainedInput[] = [];
  for (const i of bindings) {
    const state = stateOf(i.path);
    if (state === 'produced') carried.push({ id: i.id, rel: i.rel });
    else unresolved.push({ id: i.id, state });
  }
  return { carried, unresolved };
}
