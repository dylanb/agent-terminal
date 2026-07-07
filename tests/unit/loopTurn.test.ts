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

  it('when given an output artifact, requires verifying it on disk BEFORE the done-signals (§26.3 — no false done)', () => {
    // The failure this guards: a turn emits its done-signals believing it wrote its artifact when it did
    // not (a Write that silently failed / went to the wrong path), so the run detects "done" but the
    // artifact is missing → retry → error. The instruction must make the agent re-read and confirm the
    // artifact is on disk, and only THEN signal — the verification must precede the sentinel/file line.
    const artifact = '.agent-loop/reviews/2/consolidated.json';
    const instruction = doneSignalInstruction('consolidate-plan', artifact);
    const verifyIdx = instruction.indexOf(artifact);
    const sentinelIdx = instruction.indexOf(turnDoneSentinel('consolidate-plan'));
    expect(verifyIdx).toBeGreaterThanOrEqual(0); // the artifact path is named
    expect(instruction.toLowerCase()).toContain('re-read'); // confirm by re-reading, not by belief
    expect(verifyIdx).toBeLessThan(sentinelIdx); // verify FIRST, then signal done
  });

  it('omits the verification clause when no artifact is named (backward-compatible)', () => {
    const instruction = doneSignalInstruction('review-plan');
    expect(instruction).toContain(turnDoneSentinel('review-plan'));
    expect(instruction.toLowerCase()).not.toContain('re-read');
  });

  it('makes the turn-done FILE the primary completion signal and the printed line best-effort (§26.3/D46)', () => {
    // A full-screen TUI agent renders "print this line" via cursor-addressing, not clean newline-delimited
    // output, so the sentinel-line detector is unreliable against it (v2.117-class break). The FILE is the
    // robust signal, so the instruction must lead with it as REQUIRED/what-completes-the-turn and cast the
    // line as optional best-effort — the file instruction precedes the line.
    const instruction = doneSignalInstruction('consolidate-plan');
    const fileIdx = instruction.indexOf(`.agent-loop/${TURN_DONE_FILENAME}`);
    const lineIdx = instruction.indexOf(turnDoneSentinel('consolidate-plan'));
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(lineIdx).toBeGreaterThanOrEqual(0); // the exact sentinel is still named (detector contract)
    expect(fileIdx).toBeLessThan(lineIdx); // the file is instructed FIRST
    expect(instruction.toLowerCase()).toContain('completes the turn'); // the file write is what completes it
    expect(instruction.toLowerCase()).toMatch(/optional|best-effort/); // the printed line is explicitly secondary
  });
});
