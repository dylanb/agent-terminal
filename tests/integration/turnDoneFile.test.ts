import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTurnDone, clearTurnDone } from '../../src/main/turnDoneFile';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';

// §26.3/D47a — the robust half of the done-signal: the turn writes `.agent-loop/turn-done` as its last
// action. The read (which drives completion) and the delete are SEPARATE (§26.3/D46 latch): the file is
// not consumed until the done-signal has been acted on — the host clears it only at the next prompt inject
// (after /clear fired + the agent re-quiesced). Real temp files, no fs mocks.
describe('turn done-signal file (§26.3/D47a)', () => {
  let repo: string;
  const loopDir = (): string => join(repo, '.agent-loop');
  const doneFile = (): string => join(loopDir(), TURN_DONE_FILENAME);
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'turndone-'));
    mkdirSync(loopDir(), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('readTurnDone returns the trimmed turn key WITHOUT deleting the file (latched until acted on)', () => {
    writeFileSync(doneFile(), 'work-plan\n');
    expect(readTurnDone(repo)).toBe('work-plan');
    expect(existsSync(doneFile())).toBe(true); // NOT consumed by the read
    expect(readTurnDone(repo)).toBe('work-plan'); // re-readable — the signal persists
  });

  it('readTurnDone returns null when no done-signal file is present (no false positive)', () => {
    expect(readTurnDone(repo)).toBeNull();
  });

  it('clearTurnDone deletes the file (the reset performed at the next prompt inject)', () => {
    writeFileSync(doneFile(), 'work-plan\n');
    clearTurnDone(repo);
    expect(existsSync(doneFile())).toBe(false);
  });

  it('clearTurnDone is a no-op when the file is absent (never throws)', () => {
    expect(() => clearTurnDone(repo)).not.toThrow();
  });
});
