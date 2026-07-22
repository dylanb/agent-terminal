// §19.2/§27.10 — which flow transition an app-loop step entry corresponds to. Exhaustive over the shared
// `TransitionKind` union so a kind added there fails to compile here rather than inheriting the branch that
// carries artifacts and records a chained transition.

import type { TransitionKind } from '../shared/audit';
import type { AppLoopEntry } from './appLoopEngine';

export function appLoopEntryFor(kind: TransitionKind): AppLoopEntry {
  switch (kind) {
    case 'advance':
      return 'chain-advance';
    case 'start':
    case 'restart':
      return 'fresh-run';
    case 'undo':
      return 're-entry';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}
