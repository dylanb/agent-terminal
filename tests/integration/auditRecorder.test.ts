import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { parseAuditStream } from '../../src/shared/audit';
import { auditFilePath, auditRepoDir } from '../../src/main/auditPaths';

const D = new Date('2026-06-23T10:00:01.000Z');
const NOT_STARTED = { status: 'not_started' as const, stepName: 'plan' };
const IN_PROGRESS = { status: 'in_progress' as const, stepName: 'plan' };

describe('audit recorder — start opens the run file (§25.3/§25.4)', () => {
  let root: string;
  let repo: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-root-'));
    repo = mkdtempSync(join(tmpdir(), 'audit-repo-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const recorder = () => createAuditRecorder({ root, now: () => D, flowName: () => 'feature-dev' });

  it('writes a header document and a flow.started event to <root>/<basename>/<flow>_<ts>.yaml', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);

    const file = auditFilePath(root, repo, 'feature-dev', D);
    const parsed = parseAuditStream(readFileSync(file, 'utf8'));
    expect(parsed.header).toEqual({
      flow: 'feature-dev',
      repo: basename(repo),
      repoPath: repo,
      started: '2026-06-23T10:00:01Z',
    });
    expect(parsed.events).toEqual([{ ts: '2026-06-23T10:00:01Z', type: 'flow.started', step: 'plan' }]);
  });

  it('records nothing when the start did not take in_progress', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, { status: 'error', stepName: '' });
    expect(() => readFileSync(auditFilePath(root, repo, 'feature-dev', D), 'utf8')).toThrow();
  });

  it('gitignores its in-repo current-run pointer (app-owned state, §19.1)', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toContain('.agent-terminal/audit-pointer.yaml');
  });

  it('never throws into the flow path when the audit root cannot be created', () => {
    const blocker = join(tmpdir(), `audit-blocker-${basename(repo)}`);
    writeFileSync(blocker, 'not a directory');
    const rec = createAuditRecorder({ root: join(blocker, 'audit'), now: () => D, flowName: () => 'feature-dev' });
    expect(() => rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS)).not.toThrow();
    rmSync(blocker, { force: true });
  });
});

describe('audit recorder — run file lifecycle (§25.4)', () => {
  let root: string;
  let repo: string;
  let clock: Date;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'audit-root-'));
    repo = mkdtempSync(join(tmpdir(), 'audit-repo-'));
    clock = D;
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  const recorder = () => createAuditRecorder({ root, now: () => clock, flowName: () => 'feature-dev' });
  const runFiles = () => readdirSync(auditRepoDir(root, repo)).filter((f) => f.endsWith('.yaml'));
  const eventsIn = (file: string) =>
    parseAuditStream(readFileSync(join(auditRepoDir(root, repo), file), 'utf8')).events.map((e) => e.type);

  it('appends advance/done events to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTransition(repo, 'advance', IN_PROGRESS, { status: 'in_progress', stepName: 'build' });
    rec.recordTransition(repo, 'advance', { status: 'in_progress', stepName: 'build' }, { status: 'done', stepName: 'build' });

    expect(runFiles()).toHaveLength(1);
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'step.entered', 'flow.status', 'flow.completed']);
  });

  it('appends go-back-after-done events to the same file, then a new start opens a new file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTransition(repo, 'advance', IN_PROGRESS, { status: 'done', stepName: 'plan' });
    rec.recordTransition(repo, 'undo', { status: 'done', stepName: 'plan' }, IN_PROGRESS);
    expect(runFiles()).toHaveLength(1); // undo appended, did not open a new file

    clock = new Date('2026-06-25T14:12:00Z');
    rec.recordTransition(repo, 'start', { status: 'done', stepName: 'plan' }, IN_PROGRESS);
    expect(runFiles()).toHaveLength(2); // a fresh start closes the run and opens a new file
  });

  it('append-on-go-back targets the same run file after an app restart (pointer survives)', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS); // recorder A
    const fresh = recorder(); // recorder B: new in-memory map, same root/repo → reads the pointer
    fresh.recordTransition(repo, 'advance', IN_PROGRESS, { status: 'in_progress', stepName: 'build' });

    expect(runFiles()).toHaveLength(1);
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'step.entered']);
  });

  it('records nothing for an append before any run was opened', () => {
    recorder().recordTransition(repo, 'undo', { status: 'done', stepName: 'x' }, IN_PROGRESS);
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  it('records todo events to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTodoChange(repo, [], [{ id: 'a1', text: 'Wire audit IPC', status: 'active' }]);
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'todo.created']);
  });

  it('records nothing for a todo change when no run is open (no flow active)', () => {
    recorder().recordTodoChange(repo, [], [{ id: 'a1', text: 'x', status: 'active' }]);
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });
});
