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
