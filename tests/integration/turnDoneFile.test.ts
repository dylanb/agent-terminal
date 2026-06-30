import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAndClearTurnDone } from '../../src/main/turnDoneFile';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';

// §26.3/D47a — the robust half of the done-signal: the turn writes `.agent-loop/turn-done` as its last
// action. The orchestrator reads-and-clears it so a stale file can never re-fire the next turn. Real
// temp files, no fs mocks.
describe('turn done-signal file (§26.3/D47a)', () => {
  let repo: string;
  const loopDir = (): string => join(repo, '.agent-loop');
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'turndone-'));
    mkdirSync(loopDir(), { recursive: true });
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns the trimmed turn key and deletes the file (consume-once)', () => {
    writeFileSync(join(loopDir(), TURN_DONE_FILENAME), 'work-plan\n');
    expect(readAndClearTurnDone(repo)).toBe('work-plan');
    expect(existsSync(join(loopDir(), TURN_DONE_FILENAME))).toBe(false);
  });

  it('returns null when no done-signal file is present (no false positive)', () => {
    expect(readAndClearTurnDone(repo)).toBeNull();
  });
});
