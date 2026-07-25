import { describe, expect, it } from 'vitest';
import { appLoopEntryFor } from '../../src/main/appLoopEntry';

// §19.2/§27.10 — which flow transitions an app loop's declared inputs chain across. Table-driven over the
// whole TransitionKind union, so a kind added to the shared audit vocabulary cannot silently inherit the
// carrying branch.
describe('appLoopEntryFor (§19.2/§27.10)', () => {
  it('treats an advance as the chain advance', () => {
    expect(appLoopEntryFor('advance')).toBe('chain-advance');
  });

  it.each(['start', 'restart'] as const)('treats %s as a fresh run — no upstream loop ran', (kind) => {
    expect(appLoopEntryFor(kind)).toBe('fresh-run');
  });

  it('treats an undo as a re-entry, never a chain advance', () => {
    expect(appLoopEntryFor('undo')).toBe('re-entry');
  });
});
