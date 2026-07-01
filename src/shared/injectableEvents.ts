import type { MonitorEventType } from './ipc';

/** True when a monitor event of this type exposes an Insert-at-cursor affordance that writes to the
 *  live PTY (§16.2). The renderer renders that affordance and the §8.4 file loader refuses to
 *  restore such an event from its untrusted backing file; both sides decide through this one
 *  predicate so a new inject-able type cannot be added on one side and silently restored on the
 *  other (CWE-78). */
export function isInjectableEventType(type: MonitorEventType): boolean {
  return type === 'command-output';
}
