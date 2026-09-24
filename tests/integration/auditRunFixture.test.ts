import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync } from 'node:fs';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createAuditRunFixture } from '../helpers/auditRun';
import { auditRepoDir } from '../../src/main/auditPaths';

// A3 (#134) — the audit fixture the lifecycle tests assert `flow.terminated` presence/absence through: "absent"
// must never mean "looked in the wrong place" or "overwritten by a later run".
describe('audit run fixture (A3 #134)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  const NOT_STARTED = { status: 'not_started' as const, stepName: 's1' };
  const IN_PROGRESS = { status: 'in_progress' as const, stepName: 's1' };

  it('opens a run in the directory the recorder resolves, then reads its events back', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-wt');

    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);

    const file = audit.runFile(wt);
    expect(file.startsWith(auditRepoDir(audit.root, wt))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(audit.eventTypes(wt)).toContain('flow.started');
    expect(audit.eventTypes(wt)).not.toContain('flow.terminated');
  });

  it('a Terminate recorded through the same recorder appears in the run', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit-term'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-term-wt');
    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);

    audit.recorder.recordTerminate(wt);

    expect(audit.eventTypes(wt)).toContain('flow.terminated');
  });

  it('a second run after a Terminate gets its own file, so the first run keeps its flow.terminated', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit-two'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-two-wt');
    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);
    audit.recorder.recordTerminate(wt);

    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);

    const [first, second] = audit.runFiles(wt);
    expect(audit.runFiles(wt)).toHaveLength(2);
    expect(first).not.toBe(second);
    expect(audit.eventTypes(wt, 0)).toContain('flow.terminated');
    expect(audit.eventTypes(wt, 1)).toContain('flow.started');
    expect(audit.eventTypes(wt, 1)).not.toContain('flow.terminated');
    expect(audit.runFile(wt)).toBe(second);
  });

  it('a run opened straight through the recorder (as a real Start does) is the run the fixture reads', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit-direct'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-direct-wt');
    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);
    audit.recorder.recordTerminate(wt);

    audit.recorder.recordTransition(wt, 'start', NOT_STARTED, IN_PROGRESS);

    expect(audit.runFiles(wt)).toHaveLength(2);
    expect(audit.eventTypes(wt)).toContain('flow.started');
    expect(audit.eventTypes(wt)).not.toContain('flow.terminated');
  });

  it('a run file with a garbled append makes reading its events throw, rather than read the events before it as the whole run', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit-garbled'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-garbled-wt');
    audit.openRun(wt, NOT_STARTED, IN_PROGRESS);
    appendFileSync(audit.runFile(wt), '---\ntype: [unterminated\n---\nts: x\ntype: flow.terminated\n');

    expect(() => audit.eventTypes(wt)).toThrow();
  });

  it('a worktree with no opened run has no run file, and reading it says so rather than reading empty', () => {
    const audit = createAuditRunFixture(fx.outsideDir('a3-audit-none'), 'flow-a');
    const wt = fx.makeWorktree('a3-audit-none-wt');
    expect(audit.runFiles(wt)).toEqual([]);
    expect(existsSync(auditRepoDir(audit.root, wt))).toBe(false);
    expect(() => audit.runFile(wt)).toThrow();
    expect(() => audit.eventTypes(wt)).toThrow();
  });
});
