import { describe, expect, it } from 'vitest';
import { loopGateActionable } from '../../src/shared/loopGate';

// §D.4 §H.7 / WCAG 4.1.2 — `loopGateActionable` FAILS OPEN: a view is actionable unless it opts out with
// `actionable: false`. Every hand-constructed awaiting-gate view (main-side providers, tests) omits the field
// and must still render clickable controls; only the §27 run-less view sets it false. The one production
// consumer that gates decision buttons (loopPanel) always passes `actionable: true`, so this shared default is
// invisible through the panel — it needs its own test, or narrowing the predicate to `=== true` (which would
// strip controls off every field-omitting awaiting-gate view, leaving a blocked human with no keyboard-
// reachable control) passes the whole suite. Falsified by that exact `=== true` narrowing.
describe('loopGateActionable — fails open (§27 IPC item 1, §H.7, WCAG 4.1.2)', () => {
  it('an omitted actionable field is actionable', () => {
    expect(loopGateActionable({})).toBe(true);
    expect(loopGateActionable({ actionable: undefined })).toBe(true);
  });

  it('opts out ONLY on an explicit actionable: false (the run-less view)', () => {
    expect(loopGateActionable({ actionable: false })).toBe(false);
  });

  it('an explicit actionable: true is actionable', () => {
    expect(loopGateActionable({ actionable: true })).toBe(true);
  });
});
