import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_LOOP_STATE_SCHEMA,
  parseAppLoopState,
  readAppLoopState,
  serializeAppLoopState,
  writeAppLoopState,
  type AppLoopRunState,
} from '../../src/main/appLoopState';

// §27.10/§27.12 — the app-owned §27 loop-state file under <repo>/.agent-terminal/loop/, carrying a
// version/schema discriminator (mirroring §26's versioned state.yaml) so a later slice can migrate or
// reject an older resume file deterministically. Real temp files, no fs mocks. The writer is NEW in this
// slice, so its destination is confined and its FIRST-RUN test removes the target root before asserting the
// tree is created (CLAUDE.md first-run-writer rule).

const RUN: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'working' };
const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

let repo: string;
const loopDir = (): string => join(repo, '.agent-terminal', 'loop');
const stateFile = (): string => join(loopDir(), 'run-state.yaml');
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'apploop-'));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('§27 loop-state serialize/parse round-trip', () => {
  it('round-trips a working run and carries the schema discriminator', () => {
    const text = serializeAppLoopState(RUN, FIXED);
    expect(text).toContain(`schema_version: ${APP_LOOP_STATE_SCHEMA}`);
    const back = parseAppLoopState(text);
    expect(back).toEqual(RUN);
  });

  it('round-trips an errored run with its reason', () => {
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'stalled: no terminal activity' };
    expect(parseAppLoopState(serializeAppLoopState(errored, FIXED))).toEqual(errored);
  });

  it('drops the error reason on a non-error status (writer↔reader agree on the gate)', () => {
    // The reason belongs only to `error`; a `working`/`complete` run carries none, so a stale reason can
    // never render on a recovered status.
    const withReason: AppLoopRunState = { ...RUN, status: 'complete', errorReason: 'stale' };
    const back = parseAppLoopState(serializeAppLoopState(withReason, FIXED));
    expect(back).toEqual({ loop: 'plan-loop', step: 'plan', turnKey: 'work-plan', status: 'complete' });
    expect(back?.errorReason).toBeUndefined();
  });

  it('rejects a differently-versioned file rather than mis-parsing it (deterministic version gate)', () => {
    const text = serializeAppLoopState(RUN, FIXED).replace(
      `schema_version: ${APP_LOOP_STATE_SCHEMA}`,
      `schema_version: ${APP_LOOP_STATE_SCHEMA + 1}`,
    );
    expect(parseAppLoopState(text)).toBeNull();
  });

  it('returns null for a malformed document rather than throwing', () => {
    expect(parseAppLoopState('name: [unterminated')).toBeNull();
    expect(parseAppLoopState('42')).toBeNull();
  });
});

describe('§27 loop-state writer — confined, first-run, atomic, no .gitignore', () => {
  it('creates the .agent-terminal/loop tree on first run (target root absent) and reads it back', () => {
    // First-run: the fixture mkdtemp'd only the repo; neither .agent-terminal nor loop exists. The writer
    // must create the whole tree, or it ships a jail that only works when the anchor already exists.
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false);
    writeAppLoopState(repo, RUN, FIXED);
    expect(existsSync(stateFile())).toBe(true);
    expect(readAppLoopState(repo)).toEqual(RUN);
  });

  it('never writes a .gitignore (§19.1/§25 no-gitignore rule)', () => {
    writeAppLoopState(repo, RUN, FIXED);
    expect(existsSync(join(loopDir(), '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('overwrites a prior run-state atomically (whole-document, last write wins)', () => {
    writeAppLoopState(repo, RUN, FIXED);
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'no hosted agent at the prompt' };
    writeAppLoopState(repo, errored, FIXED);
    expect(readAppLoopState(repo)).toEqual(errored);
  });

  it('readAppLoopState returns null when no run-state file is present', () => {
    expect(readAppLoopState(repo)).toBeNull();
  });

  it('refuses to write through a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal')); // a planted link where the app dir should be
      expect(() => writeAppLoopState(repo, RUN, FIXED)).toThrow();
      expect(existsSync(join(elsewhere, 'loop', 'run-state.yaml'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('§27 loop-state resume reconstruction', () => {
  it('reconstructs the stopped turn (loop + step + turnKey + status) after a simulated relaunch', () => {
    const errored: AppLoopRunState = { ...RUN, status: 'error', errorReason: 'stalled: no terminal activity' };
    writeAppLoopState(repo, errored, FIXED);
    // Relaunch = a fresh read against the same repo dir; the run reconstructs which turn stopped.
    expect(readAppLoopState(repo)).toEqual(errored);
  });
});
