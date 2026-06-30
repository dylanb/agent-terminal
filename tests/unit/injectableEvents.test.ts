import { describe, expect, it } from 'vitest';
import { isInjectableEventType } from '../../src/shared/injectableEvents';
import type { MonitorEventType } from '../../src/shared/ipc';

// The monitor pane gives `command-output` cards an "Insert at cursor" affordance that writes to the
// live PTY (§16.2). Both the renderer (which renders the affordance) and the §8.4 file loader (which
// must refuse to restore an inject-able event from an untrusted file) classify "is this type
// inject-able" through this one predicate, so the two sides cannot drift.

describe('isInjectableEventType', () => {
  it('classifies command-output as inject-able (it exposes the Insert-at-cursor affordance)', () => {
    expect(isInjectableEventType('command-output')).toBe(true);
  });

  it('classifies every other event type as not inject-able', () => {
    const others: MonitorEventType[] = ['capture', 'report', 'finding', 'tool-use', 'diff', 'completion'];
    for (const t of others) expect(isInjectableEventType(t)).toBe(false);
  });
});
