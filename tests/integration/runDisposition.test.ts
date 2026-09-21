import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { worktreeStartedness } from '../../src/main/startedness';
import {
  readDisposition,
  recordDisposition,
  clearDisposition,
  runDispositionFile,
} from '../../src/main/runDisposition';

// A begun NON-catalog run — these presence/lifecycle pins care only that a run began, not which source it bound;
// AC9's source-binding round-trip is pinned separately in runDispositionBinding.test.ts.
const NON_CATALOG = { source: 'non-catalog' } as const;

// A2 (#133) §18.7.2/§18.7.4 — the run-disposition own-file marker whose presence worktreeStartedness composes to
// keep a new active-flow selection locked across a first-step revertStep. The AC7 revert-lock RED
// (startednessRevertLocked.test.ts) reaches only the record→present→'started' path; these pin the fail-closed
// read branches, the record/clear lifecycle the FlowManager wires (start records, terminate clears), and the
// AC8 own-file non-clobber invariant.

// flowState.ts keeps its STATE_REL private; worktreeFixture.ts re-spells the same leaf under flowHomeDir, so
// this reads it the same acknowledged way.
const flowStateFile = (dir: string): string => join(flowHomeDir(dir), 'flow-state.yaml');

describe('runDisposition — the durable run-begun marker (§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it("reads 'absent' for a worktree that never recorded a disposition", () => {
    const wt = fx.makeWorktree('a2-disp-absent');
    expect(readDisposition(wt)).toBe('absent');
  });

  it("reads 'present' once recordDisposition has written the marker", () => {
    const wt = fx.makeWorktree('a2-disp-present');
    recordDisposition(wt, NON_CATALOG);
    expect(readDisposition(wt)).toBe('present');
  });

  it("reads 'indeterminate' (fail-closed), never 'absent', when the marker leaf escapes the jail via a symlink (§18.7.4/CWE-59/CWE-841)", () => {
    const wt = fx.makeWorktree('a2-disp-read-escape');
    const outside = fx.outsideDir('a2-disp-read-target');
    symlinkSync(outside, runDispositionFile(wt)); // .agent-terminal is real; only the marker leaf escapes
    expect(readDisposition(wt)).toBe('indeterminate');
  });

  it('recordDisposition throws when the marker path is unresolvable — a symlink escaping the worktree (CWE-22/59)', () => {
    const wt = fx.makeWorktree('a2-disp-record-escape');
    const outside = fx.outsideDir('a2-disp-record-target');
    symlinkSync(outside, runDispositionFile(wt));
    expect(() => recordDisposition(wt, NON_CATALOG)).toThrow();
  });

  it('clearDisposition removes a non-file marker planted in the worktree, so the Terminate that clears it re-enables selection (§18.7.2 AC6/CWE-703)', () => {
    const wt = fx.makeWorktree('a2-disp-planted-dir');
    mkdirSync(runDispositionFile(wt)); // adversarial worktree content: a directory at the marker path reads 'present'
    expect(readDisposition(wt)).toBe('present');
    clearDisposition(wt);
    expect(readDisposition(wt)).toBe('absent');
  });

  it('recordDisposition leaves flow-state.yaml byte-for-byte unchanged — disjoint own files (§18.7.2 AC8)', () => {
    const wt = fx.makeWorktree('a2-disp-nonclobber-record');
    fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });
    const before = readFileSync(flowStateFile(wt));
    recordDisposition(wt, NON_CATALOG);
    expect(readFileSync(flowStateFile(wt)).equals(before)).toBe(true);
    expect(readDisposition(wt)).toBe('present');
  });

  it('clearDisposition leaves flow-state.yaml byte-for-byte unchanged — disjoint own files (§18.7.2 AC8)', () => {
    const wt = fx.makeWorktree('a2-disp-nonclobber-clear');
    fx.writeFlowState(wt, { step: 'plan', status: 'in_progress' });
    recordDisposition(wt, NON_CATALOG);
    const before = readFileSync(flowStateFile(wt));
    clearDisposition(wt);
    expect(readFileSync(flowStateFile(wt)).equals(before)).toBe(true);
  });
});

describe('runDisposition lifecycle over the real FlowManager (§18.7.2/§18.7.4)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it("start() reads 'started' and terminate() reads 'never-started': only a Terminate re-enables a new selection (§18.7.2 AC6)", () => {
    const wt = fx.makeWorktree('a2-disp-terminate');
    const globalDir = fx.makeWorktree('a2-disp-terminate-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });

    mgr.start(wt);
    expect(worktreeStartedness(wt)).toBe('started');

    mgr.terminate(wt);
    expect(worktreeStartedness(wt)).toBe('never-started');
    expect(readDisposition(wt)).toBe('absent');
  });

  it('start() does not abort when the marker write fails after the run has already committed in_progress (CWE-703/754)', () => {
    const wt = fx.makeWorktree('a2-disp-start-marker-fail');
    const globalDir = fx.makeWorktree('a2-disp-start-marker-fail-global');
    const outside = fx.outsideDir('a2-disp-start-marker-target');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    // recordDisposition will throw on this unresolvable leaf — but only AFTER decorate() has committed
    // in_progress to flow-state.yaml. The commit must stand; the marker-write fault must not abort start().
    symlinkSync(outside, runDispositionFile(wt));
    const mgr = createFlowManager({ globalDir });

    let view: ReturnType<typeof mgr.start> | undefined;
    expect(() => {
      view = mgr.start(wt);
    }).not.toThrow();
    expect(view?.status).toBe('in_progress');
  });

  it("records no marker for a start that never reaches in_progress — the guard's false side", () => {
    const wt = fx.makeWorktree('a2-disp-start-error');
    const globalDir = fx.makeWorktree('a2-disp-start-error-global');
    // A present-but-invalid local flow.yaml yields an error-state flow; start() returns 'error', not 'in_progress'.
    writeFileSync(join(flowHomeDir(wt), FLOW_DEF_FILE), 'name: bad\nsteps: []\n');
    const mgr = createFlowManager({ globalDir });

    expect(mgr.start(wt).status).toBe('error');
    expect(readDisposition(wt)).toBe('absent');
  });

  it('a progression write (advance) leaves run-disposition.yaml byte-for-byte unchanged — disjoint own files (§18.7.2 AC8)', () => {
    const wt = fx.makeWorktree('a2-disp-nonclobber-progression');
    const globalDir = fx.makeWorktree('a2-disp-nonclobber-progression-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });

    mgr.start(wt);
    const before = readFileSync(runDispositionFile(wt));
    mgr.advance(wt);
    expect(readFileSync(runDispositionFile(wt)).equals(before)).toBe(true);
  });

  it('a non-Terminate reset (restart, after the run reaches done) preserves the marker — only a Terminate re-enables a new selection (§18.7.2 AC6)', () => {
    const wt = fx.makeWorktree('a2-disp-restart-preserved');
    const globalDir = fx.makeWorktree('a2-disp-restart-preserved-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });

    mgr.start(wt);
    mgr.advance(wt); // red -> green
    mgr.advance(wt); // green -> flow done
    mgr.restart(wt); // re-begins the run; unlike terminate() it must NOT clear the marker
    expect(readDisposition(wt)).toBe('present');
    expect(worktreeStartedness(wt)).toBe('started');
  });
});
