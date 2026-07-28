import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTurnDone, clearTurnDone } from '../../src/main/turnDoneFile';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';

// §27.12 — the robust half of the done-signal: the turn writes its `turn-done` file (in the loop area the
// caller's engine owns) as its last action. The read (which drives completion) and the delete are SEPARATE
// (a latch): the file is not consumed until the done-signal has been acted on — the host clears it only at
// the next prompt inject (after /clear fired + the agent re-quiesced). The subdir is REQUIRED — no engine
// owns a default. Real temp files, no fs mocks.
describe('turn done-signal file (§27.12)', () => {
  const sub = join('.agent-terminal', 'loop');
  let repo: string;
  const loopDir = (): string => join(repo, sub);
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
    expect(readTurnDone(repo, sub)).toBe('work-plan');
    expect(existsSync(doneFile())).toBe(true); // NOT consumed by the read
    expect(readTurnDone(repo, sub)).toBe('work-plan'); // re-readable — the signal persists
  });

  it('readTurnDone returns null when no done-signal file is present (no false positive)', () => {
    expect(readTurnDone(repo, sub)).toBeNull();
  });

  it('clearTurnDone deletes the file (the reset performed at the next prompt inject)', () => {
    writeFileSync(doneFile(), 'work-plan\n');
    clearTurnDone(repo, sub);
    expect(existsSync(doneFile())).toBe(false);
  });

  it('clearTurnDone is a no-op when the file is absent (never throws)', () => {
    expect(() => clearTurnDone(repo, sub)).not.toThrow();
  });

  it('clearTurnDone never throws on an rmSync failure — it runs on the injection path (best-effort)', () => {
    // `{ force: true }` only suppresses ENOENT, not EPERM/EISDIR/transient errors. A directory at the
    // turn-done path makes rmSync throw EISDIR even with force; the clear must swallow it so a filesystem
    // error can never abort the prompt injection this runs on (CLAUDE.md best-effort; matches readTurnDone).
    mkdirSync(doneFile(), { recursive: true });
    expect(() => clearTurnDone(repo, sub)).not.toThrow();
  });

  // The subdir is the engine's own area, so a done-file under one area is invisible to a read of another —
  // two engines can never complete each other's turn through a shared default (there is none).
  it('a done-file under one subdir is not seen by a read of a different subdir', () => {
    const other = '.agent-loop';
    mkdirSync(join(repo, other), { recursive: true });
    writeFileSync(join(repo, other, TURN_DONE_FILENAME), 'work-plan\n');
    expect(readTurnDone(repo, sub)).toBeNull(); // reading the §27 area does not see the other area's file
    expect(readTurnDone(repo, other)).toBe('work-plan');
  });
});
