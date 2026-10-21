import type { TransitionKind } from '../shared/audit';
import type { AppLoopEntry } from './appLoopEngine';

/** `startEntry` (#180) is the launch contract's answer for a Start; absent or null, a Start is a fresh run. */
export function appLoopEntryFor(kind: TransitionKind, startEntry?: AppLoopEntry | null): AppLoopEntry {
  switch (kind) {
    case 'advance':
      return 'chain-advance';
    case 'start':
      return startEntry ?? 'fresh-run';
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
