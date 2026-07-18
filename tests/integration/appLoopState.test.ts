import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APP_LOOP_STATE_SCHEMA,
  parseAppLoopState,
  readAppLoopState,
  roundReportFile,
  roundReportRel,
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

  it('rejects an out-of-vocabulary status rather than surfacing a value the view/route-out cannot handle', () => {
    // A plausible-but-illegal status (e.g. 'running', 'stopped') must parse to null, not leak past the
    // STATUSES gate — the view and route-out only understand working/error/complete.
    const text = serializeAppLoopState(RUN, FIXED).replace('status: working', 'status: running');
    expect(parseAppLoopState(text)).toBeNull();
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

// §27.12/AC9 — a review-and-fix turn persists its round number so a relaunch reconstructs the stopped
// review turn AND knows which round it was. The round is absent through the work turn (no round has run).
describe('§27 loop-state — the review turn round number', () => {
  const REVIEW: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'review-plan', status: 'working', round: 1 };

  it('round-trips a review run carrying its round number', () => {
    const text = serializeAppLoopState(REVIEW, FIXED);
    expect(text).toContain('round: 1');
    expect(parseAppLoopState(text)).toEqual(REVIEW);
  });

  it('round-trips an errored review run carrying both its round and reason', () => {
    const errored: AppLoopRunState = { ...REVIEW, status: 'error', errorReason: 'report omits a roster persona' };
    expect(parseAppLoopState(serializeAppLoopState(errored, FIXED))).toEqual(errored);
  });

  it('carries no round for a work run (absent = no round has run)', () => {
    const text = serializeAppLoopState(RUN, FIXED);
    expect(text).not.toContain('round:');
    expect(parseAppLoopState(text)?.round).toBeUndefined();
  });

  it('drops a non-positive or non-integer round rather than surfacing a fabricated identity (field-local validation)', () => {
    for (const bad of ['0', '-1', '1.5', 'two']) {
      const text = serializeAppLoopState(REVIEW, FIXED).replace('round: 1', `round: ${bad}`);
      expect(parseAppLoopState(text)?.round).toBeUndefined();
    }
  });

  it('drops a non-positive or non-integer round on the WRITE side too (one gate governs serialize and parse)', () => {
    for (const bad of [0, -1, 1.5]) {
      expect(serializeAppLoopState({ ...REVIEW, round: bad }, FIXED)).not.toContain('round:');
    }
  });
});

// §27.5/AC7 — the round report's write-target (the fixer, via roundReportRel) and read-source (the engine,
// via roundReportFile) derive from ONE resolver so they cannot drift (CLAUDE.md writer↔reader-location). The
// location is round-keyed and disjoint from the engine's own run-state file, confined to the untrusted repo
// tree (resolveJail). The pin runs first-run: the fixture mkdtemp'd only the repo, so the reports tree is
// absent — a resolver that only works when the anchor already exists would fail here.
describe('§27 round-report location resolver', () => {
  it('resolves round N to <repo>/.agent-terminal/loop/reports/<N>.md, write-target === read-source', () => {
    expect(existsSync(join(repo, '.agent-terminal'))).toBe(false); // first run: the tree is absent
    expect(roundReportRel(1)).toBe('.agent-terminal/loop/reports/1.md');
    expect(roundReportFile(repo, 1)).toBe(join(realpathSync(repo), roundReportRel(1)));
    expect(roundReportFile(repo, 2)).toBe(join(realpathSync(repo), roundReportRel(2)));
  });

  it('keeps distinct rounds at disjoint locations, and disjoint from the run-state file', () => {
    expect(roundReportFile(repo, 1)).not.toBe(roundReportFile(repo, 2));
    expect(roundReportFile(repo, 1)).not.toBe(stateFile());
  });

  it('refuses a report location behind a symlinked loop container rather than following it (CWE-59)', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'apploop-evil-report-'));
    try {
      symlinkSync(elsewhere, join(repo, '.agent-terminal'));
      expect(roundReportFile(repo, 1)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
