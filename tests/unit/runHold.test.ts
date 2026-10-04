import { describe, expect, it } from 'vitest';
import {
  classifyRunHold,
  offersHeldRunRecovery,
  type HeldRunView,
  type ProgressionBegunness,
  type RunHold,
  type RunRecordRead,
} from '../../src/shared/runHold';

// A3 (#134) §18.7.3 / §18.7.4 — a held run is a definitely begun run whose record is missing or unreadable. Main's
// view projection, main's rebind refusal, and the renderer's recovery offer all classify through this one module,
// so the offer and the refusal cannot disagree (ticket "Affected contracts").

const TRUTH_TABLE: [ProgressionBegunness, RunRecordRead, RunHold][] = [
  ['begun', 'missing', 'record-missing'],
  ['begun', 'unreadable', 'record-unreadable'],
  ['begun', 'intact', 'not-held'],
  ['not-begun', 'missing', 'not-held'],
  ['not-begun', 'unreadable', 'not-held'],
  ['not-begun', 'intact', 'not-held'],
  ['indeterminate', 'missing', 'not-held'],
  ['indeterminate', 'unreadable', 'not-held'],
  ['indeterminate', 'intact', 'not-held'],
];

describe('classifyRunHold (§18.7.3 held vs indeterminate)', () => {
  it.each(TRUTH_TABLE)('a %s progression with a %s record is %s', (progression, record, expected) => {
    expect(classifyRunHold(progression, record)).toBe(expected);
  });
});

describe('offersHeldRunRecovery — the renderer offers recovery exactly for a held run', () => {
  const offered: HeldRunView[] = [
    { hold: 'record-missing', step: 's2', status: 'in_progress' },
    { hold: 'record-missing', step: 's2', status: 'done' },
    { hold: 'record-unreadable', step: 's2', status: 'in_progress' },
    { hold: 'record-unreadable', step: 's2', status: 'done' },
  ];

  it.each(offered)('offers recovery for %o', (view) => {
    expect(offersHeldRunRecovery(view)).toBe(true);
  });

  it('offers no recovery for a run that is not held', () => {
    expect(offersHeldRunRecovery({ hold: 'not-held' })).toBe(false);
  });
});
