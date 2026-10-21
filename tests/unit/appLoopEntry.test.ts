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

  // #180 — a Start answers to the start entry the launch contract hands it, and no other kind does.
  it('maps a start to the start entry it is given', () => {
    expect(appLoopEntryFor('start', 'chain-advance')).toBe('chain-advance');
  });

  it.each([undefined, null] as const)('keeps a start a fresh run when the start entry is %s', (startEntry) => {
    expect(appLoopEntryFor('start', startEntry)).toBe('fresh-run');
  });

  it.each([
    ['advance', 'chain-advance'],
    ['restart', 'fresh-run'],
    ['undo', 're-entry'],
  ] as const)('leaves %s unchanged by a start entry', (kind, entry) => {
    expect([appLoopEntryFor(kind, 're-entry'), appLoopEntryFor(kind, 'chain-advance')]).toEqual([entry, entry]);
  });
});
