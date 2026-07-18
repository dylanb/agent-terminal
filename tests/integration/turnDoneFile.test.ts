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

  it('clearTurnDone never throws on an rmSync failure — it runs on the injection path (best-effort)', () => {
    // `{ force: true }` only suppresses ENOENT, not EPERM/EISDIR/transient errors. A directory at the
    // turn-done path makes rmSync throw EISDIR even with force; the clear must swallow it so a filesystem
    // error can never abort the prompt injection this runs on (CLAUDE.md best-effort; matches readTurnDone).
    mkdirSync(doneFile(), { recursive: true });
    expect(() => clearTurnDone(repo)).not.toThrow();
  });

  // §27 carve-out — the done-file watcher/reader is LIFTED to a directory-parameterized form so the §27
  // engine keeps its done-file in its own area (.agent-terminal/loop/) while §26 (the default subdir,
  // .agent-loop) is byte-for-byte unchanged.
  describe('directory-parameterized for the §27 engine (§27.12)', () => {
    const appSub = join('.agent-terminal', 'loop');
    const appDoneFile = (): string => join(repo, appSub, TURN_DONE_FILENAME);
    beforeEach(() => {
      mkdirSync(join(repo, appSub), { recursive: true });
    });
    it('reads and clears a done-file under the supplied §27 subdir, not .agent-loop', () => {
      writeFileSync(appDoneFile(), 'work-plan\n');
      expect(readTurnDone(repo, appSub)).toBe('work-plan');
      expect(readTurnDone(repo)).toBeNull(); // the default §26 dir is untouched
      clearTurnDone(repo, appSub);
      expect(existsSync(appDoneFile())).toBe(false);
    });
  });
});
