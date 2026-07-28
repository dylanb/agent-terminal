import { describe, expect, it } from 'vitest';
import { TURN_DONE_FILENAME, doneSignalInstruction } from '../../src/shared/loopTurn';

// The per-turn done-signal contract. Completion is the turn-done FILE ONLY: a printable sentinel LINE
// was retired because a full-screen TUI agent reflows the injected prompt, so a line-detector matched
// the ECHO of its own "print this line: <sentinel>" instruction and falsely completed a turn seconds
// after it started (premature reviewers). These pins guard the cross-component agreement (the caller
// emits the instruction; main watches the FILE; the e2e fake-agent writes the FILE) so an edit on one
// side cannot silently desync.
const DONE_REL_PATH = `.agent-terminal/loop/${TURN_DONE_FILENAME}`;

describe('loop turn done-signal contract (file-only)', () => {
  it('names the done-signal file the turn writes as its final action', () => {
    expect(TURN_DONE_FILENAME).toBe('turn-done');
  });

  it('instructs writing the turn-done file with the turn key as its contents, and names the turn id', () => {
    const k = 'work-plan';
    const instruction = doneSignalInstruction(k, undefined, DONE_REL_PATH);
    expect(instruction).toContain(DONE_REL_PATH); // the file to write
    expect(instruction).toContain(k); // its contents are the turn key
    expect(instruction).toContain(`turn-done:${k}`); // the turn id token (both agent + fake-agent read it)
  });

  it('makes the turn-done FILE the completion signal and tells the agent NOT to rely on printing', () => {
    // A full-screen TUI agent renders output via cursor-addressing, not clean newline-delimited lines, and
    // the injected prompt itself is reflowed on echo — so a printed marker is both unreliable to detect AND
    // a false-completion hazard. The FILE is the sole signal; the instruction must say the file completes
    // the turn and must NOT instruct printing a completion line.
    const instruction = doneSignalInstruction('consolidate-plan', undefined, DONE_REL_PATH).toLowerCase();
    expect(instruction).toContain('completes the turn'); // the file write is what completes it
    expect(instruction).not.toContain('<<<'); // no printable sentinel is named anywhere
    expect(instruction).toMatch(/do not print|not.*rely on printing|any printed/); // printing is explicitly not the signal
  });

  it('when given an output artifact, requires verifying it on disk BEFORE the file write', () => {
    // The failure this guards: a turn writes turn-done believing it produced its artifact when it did not
    // (a Write that silently failed / went to the wrong path), so the run detects "done" but the artifact
    // is missing → retry → error. The instruction must make the agent re-read and confirm the artifact on
    // disk, and only THEN write the done-signal file.
    const artifact = '.agent-terminal/loop/reviews/2/consolidated.json';
    const instruction = doneSignalInstruction('consolidate-plan', artifact, DONE_REL_PATH);
    const verifyIdx = instruction.indexOf(artifact);
    const fileIdx = instruction.indexOf(DONE_REL_PATH);
    expect(verifyIdx).toBeGreaterThanOrEqual(0); // the artifact path is named
    expect(instruction.toLowerCase()).toContain('re-read'); // confirm by re-reading, not by belief
    expect(verifyIdx).toBeLessThan(fileIdx); // verify FIRST, then write the done-signal file
  });

  it('frames the artifact check format-agnostically — exists + non-empty, parsing only for structured files', () => {
    // The verify clause fires on both a markdown artifact (plan.md) and a JSON one (consolidated.json).
    // A blanket "parses / malformed" demand is meaningless for prose and can make the agent overfit an
    // unnecessary check; the baseline must be exists + non-empty, with parsing conditional on structure.
    const instruction = doneSignalInstruction('work-impl', '.agent-terminal/loop/plan.md', DONE_REL_PATH).toLowerCase();
    expect(instruction).toContain('non-empty');
    expect(instruction).not.toContain('malformed');
    expect(instruction).toMatch(/structured file|json.*yaml/);
  });

  it('frames the artifact check count-agnostically — the same clause fits one file or a set', () => {
    // Callers pass a single path (plan.md) or a plural/descriptive reference ("every persona's review
    // JSON…"), so the clause must not bind a singular pronoun ("verify it exists") that reads wrong for a
    // set. It uses count-neutral wording (each / any) that is correct for one artifact or many.
    const plural = doneSignalInstruction(
      'review',
      "every persona's review JSON under .agent-terminal/loop/reviews/2/",
      DONE_REL_PATH,
    ).toLowerCase();
    expect(plural).not.toContain('verify it exists');
    expect(plural).toMatch(/each (is|are)?\s*present|confirm each/);
    expect(plural).toMatch(/if any (is|are)? missing/);
  });

  it('omits the verification clause when no artifact is named (backward-compatible)', () => {
    const instruction = doneSignalInstruction('review-plan', undefined, DONE_REL_PATH);
    expect(instruction).toContain('turn-done:review-plan');
    expect(instruction.toLowerCase()).not.toContain('re-read');
  });

  it('threads any caller-supplied done-file path through unchanged, never a hardcoded one', () => {
    // The done-file location is required, not defaulted: different callers use different areas
    // (e.g. .agent-terminal/loop/ for one engine's turns), so the instruction must reflect exactly the
    // path it was given and no other.
    const rel = 'custom-area/turn-done';
    const instruction = doneSignalInstruction('work-plan', undefined, rel);
    expect(instruction).toContain(rel);
    expect(instruction).not.toContain(DONE_REL_PATH);
    expect(instruction).toContain('turn-done:work-plan');
  });
});
