import { describe, expect, it } from 'vitest';
import { TURN_DONE_FILENAME, doneSignalInstruction } from '../../src/shared/loopTurn';

// §26.3/D47a — the per-turn done-signal contract. Completion is the `.agent-loop/turn-done` FILE ONLY
// (§26 D42a fix): the printable sentinel LINE was retired because a full-screen TUI agent reflows the
// injected prompt, so the line-detector matched the ECHO of its own "print this line: <sentinel>"
// instruction and falsely completed a turn seconds after it started (premature reviewers). These pins
// guard the cross-component agreement (orchestrator emits the instruction; main watches the FILE; the
// e2e fake-agent writes the FILE) so an edit on one side cannot silently desync.
describe('loop turn done-signal contract (§26.3/D47a — file-only)', () => {
  it('names the done-signal file the turn writes under .agent-loop/', () => {
    expect(TURN_DONE_FILENAME).toBe('turn-done');
  });

  it('instructs writing the turn-done file with the turn key as its contents, and names the turn id', () => {
    const k = 'work-plan';
    const instruction = doneSignalInstruction(k);
    expect(instruction).toContain(`.agent-loop/${TURN_DONE_FILENAME}`); // the file to write
    expect(instruction).toContain(k); // its contents are the turn key
    expect(instruction).toContain(`turn-done:${k}`); // the turn id token (both agent + fake-agent read it)
  });

  it('makes the turn-done FILE the completion signal and tells the agent NOT to rely on printing (§26.3/D46)', () => {
    // A full-screen TUI agent renders output via cursor-addressing, not clean newline-delimited lines, and
    // the injected prompt itself is reflowed on echo — so a printed marker is both unreliable to detect AND
    // a false-completion hazard. The FILE is the sole signal; the instruction must say the file completes
    // the turn and must NOT instruct printing a completion line.
    const instruction = doneSignalInstruction('consolidate-plan').toLowerCase();
    expect(instruction).toContain('completes the turn'); // the file write is what completes it
    expect(instruction).not.toContain('<<<'); // no printable sentinel is named anywhere
    expect(instruction).toMatch(/do not print|not.*rely on printing|any printed/); // printing is explicitly not the signal
  });

  it('when given an output artifact, requires verifying it on disk BEFORE the file write (§26.3 — no false done)', () => {
    // The failure this guards: a turn writes turn-done believing it produced its artifact when it did not
    // (a Write that silently failed / went to the wrong path), so the run detects "done" but the artifact
    // is missing → retry → error. The instruction must make the agent re-read and confirm the artifact on
    // disk, and only THEN write the done-signal file.
    const artifact = '.agent-loop/reviews/2/consolidated.json';
    const instruction = doneSignalInstruction('consolidate-plan', artifact);
    const verifyIdx = instruction.indexOf(artifact);
    const fileIdx = instruction.indexOf(`.agent-loop/${TURN_DONE_FILENAME}`);
    expect(verifyIdx).toBeGreaterThanOrEqual(0); // the artifact path is named
    expect(instruction.toLowerCase()).toContain('re-read'); // confirm by re-reading, not by belief
    expect(verifyIdx).toBeLessThan(fileIdx); // verify FIRST, then write the done-signal file
  });

  it('omits the verification clause when no artifact is named (backward-compatible)', () => {
    const instruction = doneSignalInstruction('review-plan');
    expect(instruction).toContain('turn-done:review-plan');
    expect(instruction.toLowerCase()).not.toContain('re-read');
  });
});
