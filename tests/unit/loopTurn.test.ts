import { describe, expect, it } from 'vitest';
import { TURN_DONE_FILENAME, turnDoneSentinel, doneSignalInstruction } from '../../src/shared/loopTurn';

// §26.3/D47a — the per-turn done-signal contract. These pins guard the cross-component agreement
// (orchestrator emits the instruction; the main detectors match the line / the file; the e2e
// fake-agent reproduces both) so a behavior-preserving edit on one side cannot silently desync.
describe('loop turn done-signal contract (§26.3/D47a)', () => {
  it('scopes the sentinel line by turn key and keeps it distinctive', () => {
    const s = turnDoneSentinel('work-plan');
    expect(s).toContain('work-plan');
    expect(s).toContain('turn-done');
    expect(turnDoneSentinel('work-impl')).not.toBe(s); // per-turn, not a single global marker
  });

  it('keeps the sentinel ASCII so it survives a PTY round-trip', () => {
    // A multibyte/non-ASCII marker can be split or re-encoded across PTY chunks (§8.2).
    expect([...turnDoneSentinel('work-plan')].every((c) => c.charCodeAt(0) <= 0x7e)).toBe(true);
  });

  it('the instruction references the exact line the detector matches (the agreement)', () => {
    const k = 'work-plan';
    const instruction = doneSignalInstruction(k);
    expect(instruction).toContain(turnDoneSentinel(k));
    expect(instruction).toContain(TURN_DONE_FILENAME);
    expect(instruction).toContain(k);
  });

  it('names the done-signal file the turn writes under .agent-loop/', () => {
    expect(TURN_DONE_FILENAME).toBe('turn-done');
  });
});
