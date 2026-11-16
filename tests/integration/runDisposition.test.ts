import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowManager, flowHomeDir, loadFlowDefinition, FLOW_DEF_FILE } from '../../src/main/flow';
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
// keep a new active-flow selection locked once a run has begun. The revertStep pins (revertStepRunRecord.test.ts)
// reach only the record lifecycle through the FlowManager; these pin the fail-closed
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

  it('recordDisposition replaces a symlink planted at the marker leaf, never writing through it (CWE-22/59)', () => {
    const wt = fx.makeWorktree('a2-disp-record-escape');
    const outside = fx.outsideDir('a2-disp-record-target');
    symlinkSync(outside, runDispositionFile(wt));
    recordDisposition(wt, NON_CATALOG);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(runDispositionFile(wt)).isFile()).toBe(true);
  });

  it('recordDisposition throws when the flow home itself is a symlink escaping the worktree (CWE-22/59)', () => {
    const wt = fx.makeWorktree('a2-disp-record-home-escape');
    const outside = fx.outsideDir('a2-disp-record-home-target');
    rmSync(flowHomeDir(wt), { recursive: true, force: true });
    symlinkSync(outside, flowHomeDir(wt));
    expect(() => recordDisposition(wt, NON_CATALOG)).toThrow();
    expect(readdirSync(outside)).toEqual([]);
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

  const asRoot = process.getuid?.() === 0; // root ignores the 0o555 fault these pins inject

  it.skipIf(asRoot)('a marker that cannot be written refuses the start with a reason, leaving the run not_started (§18.7.3 AC9)', () => {
    const wt = fx.makeWorktree('a2-disp-start-marker-fail');
    const globalDir = fx.makeWorktree('a2-disp-start-marker-fail-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });
    chmodSync(flowHomeDir(wt), 0o555);
    try {
      const view = mgr.start(wt);
      expect(view.status).toBe('not_started');
      expect(view.notice).toMatch(/could not be started/);
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }
    expect(mgr.state(wt).status).toBe('not_started');
  });

  it.skipIf(asRoot)('a marker that cannot be cleared refuses the Terminate with a reason, and a retry after the fault clears unlocks (§18.7.2 AC6)', () => {
    const wt = fx.makeWorktree('a2-disp-terminate-fault');
    const globalDir = fx.makeWorktree('a2-disp-terminate-fault-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });
    mgr.start(wt);
    chmodSync(flowHomeDir(wt), 0o555);
    try {
      const refused = mgr.terminate(wt);
      expect(refused.view.status).toBe('in_progress');
      expect(refused.view.notice).toMatch(/could not be terminated/);
    } finally {
      chmodSync(flowHomeDir(wt), 0o755);
    }
    expect(mgr.terminate(wt).view.status).toBe('not_started');
    expect(worktreeStartedness(wt)).toBe('never-started');
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

  it('a start whose definition stops loading after the marker is recorded rolls the marker back, leaving the worktree never-started', () => {
    const wt = fx.makeWorktree('a2-disp-start-rollback');
    const globalDir = fx.makeWorktree('a2-disp-start-rollback-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const load = loadFlowDefinition(wt, null);
    let calls = 0;
    const mgr = createFlowManager({
      globalDir,
      loadDefinition: () =>
        calls++ === 0 ? { load, binding: NON_CATALOG } : { load: { ok: false, error: 'flow.yaml vanished' } },
    });

    expect(mgr.start(wt).status).toBe('error');
    expect(readDisposition(wt)).toBe('absent');
    expect(worktreeStartedness(wt)).toBe('never-started');
  });

  it.skipIf(asRoot)('a Terminate that resets the run but cannot remove its run record says so and keeps selection locked (fail-closed)', () => {
    const wt = fx.makeWorktree('a2-disp-terminate-record-stuck');
    const globalDir = fx.makeWorktree('a2-disp-terminate-record-stuck-global');
    fx.writeFlowHome(wt, { name: 'local-flow', stepIds: ['red', 'green'] });
    const mgr = createFlowManager({ globalDir });
    mgr.start(wt);
    const marker = runDispositionFile(wt);
    rmSync(marker);
    mkdirSync(join(marker, 'locked'), { recursive: true });
    writeFileSync(join(marker, 'locked', 'entry'), '');
    chmodSync(join(marker, 'locked'), 0o555);
    try {
      const after = mgr.terminate(wt);
      expect(after.outcome).toBe('reset');
      expect(after.view.status).toBe('not_started');
      expect(after.view.notice).toMatch(/cannot be selected until its run record is removed/);
      expect(after.view.runStarted).toBe('started');
    } finally {
      chmodSync(join(marker, 'locked'), 0o755);
    }
  });
});
