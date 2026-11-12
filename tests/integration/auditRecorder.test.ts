import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditTimestamp, parseAuditStream, reconstructTimeline, type AuditEvent } from '../../src/shared/audit';
import { auditFilePath, auditRepoDir } from '../../src/main/auditPaths';

const D = new Date('2026-06-23T10:00:01.250Z');
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

  it('writes a header document, its start to the second, and a flow.started event to the millisecond to <root>/<basename>/<flow>_<ts>.yaml', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);

    const file = auditFilePath(root, repo, 'feature-dev', D);
    const parsed = parseAuditStream(readFileSync(file, 'utf8'));
    expect(parsed.header).toEqual({
      flow: 'feature-dev',
      repo: basename(repo),
      repoPath: repo,
      started: '2026-06-23T10:00:01Z',
    });
    expect(parsed.events).toEqual([{ ts: '2026-06-23T10:00:01.250Z', type: 'flow.started', step: 'plan' }]);
  });

  it('records nothing when the start did not take in_progress', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, { status: 'error', stepName: '' });
    expect(() => readFileSync(auditFilePath(root, repo, 'feature-dev', D), 'utf8')).toThrow();
  });

  it('never creates a .gitignore for its in-repo pointer — the app does not modify the user\'s VCS config', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged across repeated runs', () => {
    const before = 'node_modules';
    writeFileSync(join(repo, '.gitignore'), before);
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    expect(readFileSync(join(repo, '.gitignore'), 'utf8')).toBe(before);
  });

  it('writes the run file and audit dir owner-only (CWE-276 least-privilege)', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    const file = auditFilePath(root, repo, 'feature-dev', D);
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(statSync(auditRepoDir(root, repo)).mode & 0o077).toBe(0);
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

  it('neither appends to a file the repo\'s pointer names outside the audit root nor opens a run for it', () => {
    const outside = join(repo, 'elsewhere.yaml');
    const header = 'kind: header\nflow: feature-dev\nrepoPath: /somewhere/else\nstarted: 2026-06-23T10:00:01Z\n';
    writeFileSync(outside, `---\n${header}`);
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'audit-pointer.yaml'), `file: ${outside}\n`);

    recorder().recordCommand(repo, 'flow', 'echo hi', 0);

    expect({ outside: readFileSync(outside, 'utf8'), runDir: existsSync(auditRepoDir(root, repo)) }).toEqual({ outside: `---\n${header}`, runDir: false });
  });

  it('does not append to another repo\'s record that this repo\'s pointer names inside the audit root', () => {
    const other = mkdtempSync(join(tmpdir(), 'audit-other-'));
    try {
      recorder().recordTransition(other, 'start', NOT_STARTED, IN_PROGRESS);
      const otherFile = join(auditRepoDir(root, other), readdirSync(auditRepoDir(root, other)).find((f) => f.endsWith('.yaml'))!);
      const before = readFileSync(otherFile, 'utf8');
      mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
      writeFileSync(join(repo, '.agent-terminal', 'audit-pointer.yaml'), `file: ${otherFile}\n`);

      const fresh = recorder();
      fresh.recordCommand(repo, 'flow', 'echo hi', 0);
      fresh.recordTransition(repo, 'advance', IN_PROGRESS, { status: 'in_progress', stepName: 'build' });

      expect(readFileSync(otherFile, 'utf8')).toBe(before);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('logs a refused pointer once, without the raw control characters its text carries', () => {
    const logged: unknown[][] = [];
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(join(repo, '.agent-terminal', 'audit-pointer.yaml'), 'file: "/x\\e]0;PWNED\\a\\n[fake] audit ok"\n');
    const rec = createAuditRecorder({ root, now: () => clock, flowName: () => 'feature-dev', log: (...args) => void logged.push(args) });

    for (let i = 0; i < 3; i++) rec.recordCommand(repo, 'flow', 'echo hi', 0);

    expect({ entries: logged.length, raw: logged.some((args) => args.some((a) => typeof a === 'string' && /[\u0000-\u001f\u007f]/.test(a))) }).toEqual({ entries: 1, raw: false });
  });

  it('does not append to the record of a same-named repo elsewhere that this repo\'s pointer names', () => {
    const parents = [mkdtempSync(join(tmpdir(), 'audit-twin-a-')), mkdtempSync(join(tmpdir(), 'audit-twin-b-'))];
    const [first, second] = parents.map((p) => join(p, 'proj'));
    try {
      for (const dir of [first, second]) mkdirSync(dir);
      recorder().recordTransition(first, 'start', NOT_STARTED, IN_PROGRESS);
      const firstFile = join(auditRepoDir(root, first), readdirSync(auditRepoDir(root, first)).find((f) => f.endsWith('.yaml'))!);
      const before = readFileSync(firstFile, 'utf8');
      mkdirSync(join(second, '.agent-terminal'), { recursive: true });
      writeFileSync(join(second, '.agent-terminal', 'audit-pointer.yaml'), `file: ${firstFile}\n`);

      const fresh = recorder();
      fresh.recordCommand(second, 'flow', 'echo hi', 0);
      fresh.recordTransition(second, 'advance', IN_PROGRESS, { status: 'in_progress', stepName: 'build' });

      expect(readFileSync(firstFile, 'utf8')).toBe(before);
    } finally {
      for (const p of parents) rmSync(p, { recursive: true, force: true });
    }
  });

  it('after a restart, keeps recording a run started through a link to the repo when the repo is reached by its real path', () => {
    const linkParent = mkdtempSync(join(tmpdir(), 'audit-link-'));
    const viaLink = join(linkParent, basename(repo));
    try {
      symlinkSync(repo, viaLink);
      recorder().recordTransition(viaLink, 'start', NOT_STARTED, IN_PROGRESS);

      recorder().recordTransition(repo, 'advance', IN_PROGRESS, { status: 'in_progress', stepName: 'build' });

      expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'step.entered']);
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

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

  it('records loop status/iteration/pr changes from the §27 loop view to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null }); // idempotent re-pull → nothing
    rec.recordLoop(repo, { status: 'awaiting-human-pr-approval', iteration: 4, pr: 42 });

    expect(eventsIn(runFiles()[0])).toEqual([
      'flow.started',
      'loop.status',
      'loop.iteration',
      'outputs.snapshot', // a status change snapshots the loop's outputs (§25.5)
      'loop.status',
      'loop.iteration',
      'pr.assoc',
      'outputs.snapshot',
    ]);
  });

  it('records nothing for a loop observation when no run is open', () => {
    recorder().recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  // §24.2.3 T4 — the OS can refuse to deliver a raise (macOS denies an unsigned bundle outright). A
  // rejected raise must never look like a raise that was never attempted.
  it('records a rejected OS notification to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordNotifyFailed(repo, 'Notifications are not allowed for this application');
    const events = parseAuditStream(readFileSync(join(auditRepoDir(root, repo), runFiles()[0]), 'utf8')).events;
    expect(events.map((e) => e.type)).toEqual(['flow.started', 'notify.failed']);
    expect(events[1]).toMatchObject({ type: 'notify.failed', reason: 'Notifications are not allowed for this application' });
  });

  it('strips control characters out of a rejected notification reason (CWE-117)', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordNotifyFailed(repo, 'denied\n---\ntype: flow.terminated');
    const events = parseAuditStream(readFileSync(join(auditRepoDir(root, repo), runFiles()[0]), 'utf8')).events;
    expect(events.map((e) => e.type)).toEqual(['flow.started', 'notify.failed']);
    expect(events[1]).toMatchObject({ type: 'notify.failed', reason: 'denied --- type: flow.terminated' });
  });

  it('records nothing for a rejected notification when no run is open', () => {
    recorder().recordNotifyFailed(repo, 'denied');
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  it('re-records the initial loop status after a fresh start (per-run diff resets)', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    clock = new Date('2026-06-25T14:12:00Z');
    rec.recordTransition(repo, 'start', { status: 'done', stepName: 'plan' }, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });

    const newest = runFiles().sort().at(-1)!;
    expect(eventsIn(newest)).toEqual(['flow.started', 'loop.status', 'loop.iteration', 'outputs.snapshot']);
  });

  it('records resolved inputs and a ticket association to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordInputs(repo, { ticket: '176' }, { ticket: 'github-ticket' });
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'input.resolved', 'ticket.assoc']);
  });

  it('records a step\'s decision to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordDecision(repo, 'plan', 'b');
    const events = parseAuditStream(readFileSync(join(auditRepoDir(root, repo), runFiles()[0]), 'utf8')).events;
    expect(events.map((e) => e.type)).toEqual(['flow.started', 'decision']);
    expect(events[1]).toMatchObject({ type: 'decision', step: 'plan', value: 'b' });
  });

  it('records nothing for a decision when no run is open', () => {
    recorder().recordDecision(repo, 'plan', 'b');
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  it('records nothing for resolved inputs when no run is open', () => {
    recorder().recordInputs(repo, { ticket: '176' }, { ticket: 'github-ticket' });
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  const snapshotsIn = (file: string): Extract<AuditEvent, { type: 'outputs.snapshot' }>[] =>
    parseAuditStream(readFileSync(join(auditRepoDir(root, repo), file), 'utf8')).events.filter(
      (e): e is Extract<AuditEvent, { type: 'outputs.snapshot' }> => e.type === 'outputs.snapshot',
    );

  it('snapshots the .agent-loop/ files (path + bytes) and PR on a loop status change', () => {
    const loopDir = join(repo, '.agent-loop');
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, 'plan.md'), 'a'.repeat(20));
    writeFileSync(join(loopDir, 'pr-context.md'), 'b'.repeat(5));

    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: 42 });

    const snaps = snapshotsIn(runFiles()[0]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].pr).toBe(42);
    expect(snaps[0].files).toEqual([
      { path: '.agent-loop/plan.md', bytes: 20 },
      { path: '.agent-loop/pr-context.md', bytes: 5 },
    ]);
  });

  it('does not snapshot when only iteration or PR changes (status unchanged)', () => {
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), 'x');
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'building', iteration: 1, pr: null }); // status change → snapshot
    rec.recordLoop(repo, { status: 'building', iteration: 2, pr: 42 }); // iteration+pr only → no snapshot
    expect(snapshotsIn(runFiles()[0])).toHaveLength(1);
  });

  it('reconstructs the correct final loop state after a restart rehydrates the run pointer', () => {
    const a = recorder();
    a.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    a.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    // A fresh recorder models an app restart: it rehydrates the open run from the on-disk pointer with
    // an empty in-memory loop baseline, so the next observation re-emits the entry status (§25.4).
    const b = recorder();
    b.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    b.recordLoop(repo, { status: 'building', iteration: 2, pr: 42 });

    const tl = reconstructTimeline(readFileSync(join(auditRepoDir(root, repo), runFiles()[0]), 'utf8'));
    expect(tl.loop).toEqual({ status: 'building', iteration: 2 });
    expect(tl.pr).toBe(42);
  });

  it('takes one snapshot per status change, not per idempotent re-pull', () => {
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), 'x');
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null }); // no change → no snapshot
    rec.recordLoop(repo, { status: 'building', iteration: 2, pr: null }); // status change → snapshot
    expect(snapshotsIn(runFiles()[0])).toHaveLength(2);
  });

  it('records a flow-injected bootstrap command and its exit to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordCommand(repo, 'bootstrap', 'agent-loop pickup 176', 127);
    const cmd = parseAuditStream(readFileSync(join(auditRepoDir(root, repo), runFiles()[0]), 'utf8')).events.find(
      (e): e is Extract<AuditEvent, { type: 'command' }> => e.type === 'command',
    );
    expect(cmd).toEqual({ ts: '2026-06-23T10:00:01.250Z', type: 'command', source: 'bootstrap', cmd: 'agent-loop pickup 176', exit: 127 });
  });

  it('records nothing for a command when no run is open', () => {
    recorder().recordCommand(repo, 'bootstrap', 'agent-loop pickup 1', 0);
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  it('excludes a .agent-loop/ symlink that escapes the repo (§20.2)', () => {
    const loopDir = join(repo, '.agent-loop');
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(join(loopDir, 'plan.md'), 'in-repo');
    const outside = join(tmpdir(), `audit-escape-${basename(repo)}.txt`);
    writeFileSync(outside, 'secret');
    symlinkSync(outside, join(loopDir, 'escape.md'));

    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });

    const files = snapshotsIn(runFiles()[0])[0].files.map((f) => f.path);
    expect(files).toEqual(['.agent-loop/plan.md']);
    rmSync(outside, { force: true });
  });

  it('excludes everything when .agent-loop itself is a symlink escaping the repo (§20.2/§25.7)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'audit-loopdir-escape-'));
    writeFileSync(join(outside, 'leak.md'), 'secret');
    symlinkSync(outside, join(repo, '.agent-loop'));

    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordLoop(repo, { status: 'planning', iteration: 1, pr: null });

    expect(snapshotsIn(runFiles()[0])[0].files).toEqual([]);
    rmSync(outside, { recursive: true, force: true });
  });
});

// Terminate finalization (#26 AC8/AC12 / §25.4): appends flow.terminated to the open run, then
// finalizes it so the NEXT start opens a new run file. Best-effort: never throws into the flow path.
describe('audit recorder — terminate finalization (§25.4 / #26)', () => {
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

  it('appends a flow.terminated event to the open run file', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTerminate(repo);
    expect(runFiles()).toHaveLength(1);
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'flow.terminated']);
  });

  it('finalizes the run so the next start opens a new run file (§25.4)', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTerminate(repo);
    clock = new Date('2026-06-25T14:12:00Z');
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    expect(runFiles()).toHaveLength(2); // the terminated run + a fresh one
  });

  it('records nothing after terminate finalized the run until the next start (no stale appends)', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    rec.recordTerminate(repo);
    rec.recordTodoChange(repo, [], [{ id: 'a1', text: 'x', status: 'active' }]);
    rec.recordCommand(repo, 'bootstrap', 'agent-loop pickup 1', 0);
    expect(eventsIn(runFiles()[0])).toEqual(['flow.started', 'flow.terminated']);
  });

  it('terminate is a no-op when no run is open (best-effort, never throws)', () => {
    const rec = recorder();
    expect(() => rec.recordTerminate(repo)).not.toThrow();
    expect(existsSync(auditRepoDir(root, repo))).toBe(false);
  });

  it('never throws into the flow path when appending the termination event fails (§25.7 / AC8)', () => {
    const rec = recorder();
    rec.recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    const file = join(auditRepoDir(root, repo), runFiles()[0]);
    rmSync(file);
    mkdirSync(file); // a directory at the run-file path makes appendFileSync throw EISDIR
    expect(() => rec.recordTerminate(repo)).not.toThrow();
  });

  it('finalizes the run pointer so a restart-rehydrated recorder opens a fresh run on the next start (AC12)', () => {
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    recorder().recordTerminate(repo); // a fresh recorder (app restart) reads the pointer, then clears it
    clock = new Date('2026-06-25T14:12:00Z');
    recorder().recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS);
    expect(runFiles()).toHaveLength(2);
  });
});

// `loop.cost` and `loop.ci` are CLOSED to new writers. The READER still folds both (audit.test.ts)
// so a pre-sweep stream reconstructs whole, but the writer half is retired: NO production emitter may
// produce either kind, or one union member would carry two meanings on the unversioned, never-migrated
// append-only log and `reconstructTimeline` would merge pre- and post-sweep records (N7/#92 takes distinct
// `app.cost`/`app.ci` names instead). This guards the failure mode the sweep left unpinned: a re-added emitter
// method on the §25 writer compiles clean and leaves the behavioural suite green because nothing drives it.
describe('audit writer — the retired cost/ci kinds stay closed to new writers', () => {
  const writerSrc = readFileSync(new URL('../../src/main/auditRecorder.ts', import.meta.url), 'utf8');

  // The writer neither declares the retired union (that is the reader, `audit.ts`) nor reads these kinds, so
  // the token appears in the writer ONLY if something emits it. Match the whole `loop.cost` / `loop.ci` token
  // (a trailing non-word boundary rules out `loop.circular`) in ANY quote form — `'…'`, `"…"`, or a template
  // `` `…` `` — so the guard cannot be evaded by swapping quotes, the exact escape a string-literal match left open.
  for (const kind of ['loop.cost', 'loop.ci']) {
    it(`the §25 writer constructs no ${kind} event`, () => {
      const token = new RegExp(`\\bloop\\.${kind.slice('loop.'.length)}\\b`);
      expect(token.test(writerSrc), `src/main/auditRecorder.ts must not name a ${kind} event (§H.1: closed to new writers)`).toBe(false);
    });
  }
});

// #137 — the Start reads the clock once: the run's §25 file and header take the Start's instant and flow name,
// never the recorder's own clock or a live flow-name read.
describe('audit recorder — the start leg takes the run\'s Start identity (#137)', () => {
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

  it('names the file and stamps the header from the Start instant and flow, a second before the recorder\'s clock', () => {
    const startedAt = Date.parse('2026-06-23T10:00:01.999Z');
    const later = new Date(startedAt + 1_000);
    createAuditRecorder({ root, now: () => later, flowName: () => 'another-flow' }).recordTransition(repo, 'start', NOT_STARTED, IN_PROGRESS, { startedAt, flow: 'Auto Gate Flow' });

    const file = auditFilePath(root, repo, 'Auto Gate Flow', new Date(startedAt));
    expect(readdirSync(auditRepoDir(root, repo))).toEqual([basename(file)]);
    expect(parseAuditStream(readFileSync(file, 'utf8')).header).toMatchObject({ flow: 'Auto Gate Flow', started: auditTimestamp(new Date(startedAt)) });
  });
});
