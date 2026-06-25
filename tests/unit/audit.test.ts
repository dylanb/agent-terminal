import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  auditFileStamp,
  auditTimestamp,
  inputEvents,
  lifecycleEvents,
  loopEvents,
  parseAuditStream,
  reconstructTimeline,
  serializeDoc,
  todoEvents,
  type AuditEvent,
  type AuditHeader,
  type TodoLike,
} from '../../src/shared/audit';
import { auditFileName, auditFilePath, auditRepoDir, auditRootDir } from '../../src/main/auditPaths';

const D = new Date('2026-06-23T10:00:01.500Z');

describe('audit timestamps (§25.2/§25.3)', () => {
  it('renders an ISO-8601 UTC second-precision ts for events', () => {
    expect(auditTimestamp(D)).toBe('2026-06-23T10:00:01Z');
  });
  it('renders a filesystem-safe stamp (colons → dashes) for the file name', () => {
    expect(auditFileStamp(D)).toBe('2026-06-23T10-00-01Z');
  });
});

describe('audit path derivation (§25.2)', () => {
  it('roots at ~/.agent-terminal/audit', () => {
    expect(auditRootDir('/home/me')).toBe(path.join('/home/me', '.agent-terminal', 'audit'));
  });
  it('uses the repo basename only for the per-repo directory', () => {
    expect(auditRepoDir('/root', '/a/b/agent-terminal')).toBe(path.join('/root', 'agent-terminal'));
  });
  it('names the file <flow>_<stamp>.yaml', () => {
    expect(auditFileName('feature-dev', D)).toBe('feature-dev_2026-06-23T10-00-01Z.yaml');
  });
  it('sanitizes an untrusted flow name so it cannot traverse the audit tree (CWE-22)', () => {
    const repoDir = auditRepoDir('/root', '/a/b/repo');
    const p = auditFilePath('/root', '/a/b/repo', '../../etc/passwd', D);
    expect(p.startsWith(repoDir + path.sep)).toBe(true);
    expect(p.includes('..')).toBe(false);
    expect(path.dirname(p)).toBe(repoDir);
  });
});

describe('audit stream serialize ↔ parse (§25.3)', () => {
  const header: AuditHeader = {
    flow: 'feature-dev',
    repo: 'agent-terminal',
    repoPath: '/a/b/agent-terminal',
    started: '2026-06-23T10:00:01Z',
  };
  const events: AuditEvent[] = [
    { ts: '2026-06-23T10:00:01Z', type: 'flow.started', step: 'plan' },
    { ts: '2026-06-23T10:30:00Z', type: 'step.entered', step: 'build' },
  ];

  it('round-trips a header and its events through one append-only stream', () => {
    const stream = [serializeDoc(header), ...events.map(serializeDoc)].join('');
    const parsed = parseAuditStream(stream);
    expect(parsed.header).toEqual(header);
    expect(parsed.events).toEqual(events);
  });

  it('preserves untrusted todo text containing YAML-special characters', () => {
    const ev: AuditEvent = { ts: '2026-06-23T10:00:01Z', type: 'todo.created', id: 'a1', text: 'fix: a #b "c" {d}' };
    const stream = serializeDoc(header) + serializeDoc(ev);
    expect(parseAuditStream(stream).events).toEqual([ev]);
  });

  it('tolerates a trailing partial document from a crash mid-append (discards it)', () => {
    const good = serializeDoc(header) + serializeDoc(events[0]);
    const stream = good + '---\nts: 2026-06-23T10:30:00Z\ntype: "step.ent'; // crash mid-append: unterminated
    const parsed = parseAuditStream(stream);
    expect(parsed.header).toEqual(header);
    expect(parsed.events).toEqual([events[0]]);
  });
});

describe('lifecycleEvents — start opens the run (§25.4/§25.5)', () => {
  it('emits a single flow.started carrying the entry step', () => {
    const before = { status: 'not_started' as const, stepName: 'plan' };
    const after = { status: 'in_progress' as const, stepName: 'plan' };
    expect(lifecycleEvents('start', before, after, '2026-06-23T10:00:01Z')).toEqual([
      { ts: '2026-06-23T10:00:01Z', type: 'flow.started', step: 'plan' },
    ]);
  });
  it('emits nothing when the start did not take (still not in_progress)', () => {
    const v = { status: 'error' as const, stepName: '' };
    expect(lifecycleEvents('start', v, v, '2026-06-23T10:00:01Z')).toEqual([]);
  });
});

describe('lifecycleEvents — append kinds diff before/after (§25.4/§25.5)', () => {
  const T = '2026-06-23T11:00:00Z';
  const inProg = (stepName: string) => ({ status: 'in_progress' as const, stepName });
  const done = (stepName: string) => ({ status: 'done' as const, stepName });

  it('advance into a new step within a run emits step.entered only', () => {
    expect(lifecycleEvents('advance', inProg('plan'), inProg('build'), T)).toEqual([
      { ts: T, type: 'step.entered', step: 'build' },
    ]);
  });

  it('advance into done emits flow.status then flow.completed (no step.entered)', () => {
    expect(lifecycleEvents('advance', inProg('build'), done('build'), T)).toEqual([
      { ts: T, type: 'flow.status', from: 'in_progress', to: 'done' },
      { ts: T, type: 'flow.completed', step: 'build' },
    ]);
  });

  it('restart from done re-enters the first step: flow.status then step.entered', () => {
    expect(lifecycleEvents('restart', done('build'), inProg('plan'), T)).toEqual([
      { ts: T, type: 'flow.status', from: 'done', to: 'in_progress' },
      { ts: T, type: 'step.entered', step: 'plan' },
    ]);
  });

  it('undo from done stays on the step: flow.status only', () => {
    expect(lifecycleEvents('undo', done('build'), inProg('build'), T)).toEqual([
      { ts: T, type: 'flow.status', from: 'done', to: 'in_progress' },
    ]);
  });

  it('never emits a flow.status carrying error, which is outside the §25.5 vocabulary', () => {
    const fromError = lifecycleEvents('advance', { status: 'error', stepName: 's' }, inProg('s'), T);
    const toError = lifecycleEvents('advance', inProg('s'), { status: 'error', stepName: 's' }, T);
    expect(fromError.some((e) => e.type === 'flow.status')).toBe(false);
    expect(toError.some((e) => e.type === 'flow.status')).toBe(false);
  });
});

describe('loopEvents — diff the agent-loop state.yaml mirror (§25.5)', () => {
  const T = '2026-06-23T10:30:00Z';
  const loop = (status: string, iteration: number, pr: number | null) => ({ status, iteration, pr });

  it('records the initial status, iteration, and PR on first observation (no prior)', () => {
    expect(loopEvents(null, loop('planning', 1, null), T)).toEqual([
      { ts: T, type: 'loop.status', from: '', to: 'planning' },
      { ts: T, type: 'loop.iteration', n: 1 },
    ]);
  });

  it('associates the PR the first time state.yaml carries one', () => {
    expect(loopEvents(loop('building', 3, null), loop('building', 3, 42), T)).toEqual([
      { ts: T, type: 'pr.assoc', pr: 42 },
    ]);
  });

  it('records a status change and an iteration bump together', () => {
    expect(loopEvents(loop('building', 3, 42), loop('awaiting-human-pr-approval', 4, 42), T)).toEqual([
      { ts: T, type: 'loop.status', from: 'building', to: 'awaiting-human-pr-approval' },
      { ts: T, type: 'loop.iteration', n: 4 },
    ]);
  });

  it('records nothing when status, iteration, and PR are unchanged', () => {
    expect(loopEvents(loop('building', 3, 42), loop('building', 3, 42), T)).toEqual([]);
  });

  it('records nothing when the loop view is absent (left the loop step)', () => {
    expect(loopEvents(loop('building', 3, 42), null, T)).toEqual([]);
  });

  it('strips control characters from the untrusted status on first observation (CWE-117, §25.7)', () => {
    expect(loopEvents(null, loop('building', 1, null), T)).toEqual([
      { ts: T, type: 'loop.status', from: '', to: 'building  ' },
      { ts: T, type: 'loop.iteration', n: 1 },
    ]);
  });

  it('strips control characters from both sides of a status transition (CWE-117, §25.7)', () => {
    expect(loopEvents(loop('a', 1, null), loop('b', 2, null), T)).toEqual([
      { ts: T, type: 'loop.status', from: 'a ', to: 'b ' },
      { ts: T, type: 'loop.iteration', n: 2 },
    ]);
  });
});

describe('inputEvents — resolved flow inputs and ticket association (§25.5)', () => {
  const T = '2026-06-23T10:00:06Z';

  it('records input.resolved for each value', () => {
    expect(inputEvents({ branch: 'main' }, { branch: 'free-text' }, T)).toEqual([
      { ts: T, type: 'input.resolved', name: 'branch', value: 'main' },
    ]);
  });

  it('also associates the ticket when a github-ticket input resolves to a number', () => {
    expect(inputEvents({ ticket: '176' }, { ticket: 'github-ticket' }, T)).toEqual([
      { ts: T, type: 'input.resolved', name: 'ticket', value: '176' },
      { ts: T, type: 'ticket.assoc', ticket: 176 },
    ]);
  });

  it('records the input but no ticket when a github-ticket value is not a positive integer', () => {
    expect(inputEvents({ ticket: 'oops' }, { ticket: 'github-ticket' }, T)).toEqual([
      { ts: T, type: 'input.resolved', name: 'ticket', value: 'oops' },
    ]);
  });
});

describe('reconstructTimeline — replay a full run into its ordered timeline + final state (§25.6)', () => {
  const header: AuditHeader = {
    flow: 'feature-dev',
    repo: 'agent-terminal',
    repoPath: '/a/b/agent-terminal',
    started: '2026-06-23T10:00:01Z',
  };
  const events: AuditEvent[] = [
    { ts: '2026-06-23T10:00:01Z', type: 'flow.started', step: 'plan' },
    { ts: '2026-06-23T10:00:06Z', type: 'input.resolved', name: 'ticket', value: '17' },
    { ts: '2026-06-23T10:00:06Z', type: 'ticket.assoc', ticket: 17 },
    { ts: '2026-06-23T10:00:07Z', type: 'command', source: 'bootstrap', cmd: 'agent-loop pickup 17', exit: 0 },
    { ts: '2026-06-23T10:02:11Z', type: 'todo.created', id: 'a1', text: 'Wire audit IPC' },
    { ts: '2026-06-23T10:02:12Z', type: 'todo.created', id: 'a2', text: 'Add reconstructor' },
    { ts: '2026-06-23T10:05:00Z', type: 'todo.status', id: 'a1', from: 'active', to: 'done' },
    { ts: '2026-06-23T10:06:00Z', type: 'todo.deleted', id: 'a2' },
    { ts: '2026-06-23T10:30:00Z', type: 'loop.status', from: '', to: 'building' },
    { ts: '2026-06-23T10:30:00Z', type: 'loop.iteration', n: 3 },
    { ts: '2026-06-23T10:40:00Z', type: 'pr.assoc', pr: 42 },
    { ts: '2026-06-23T10:40:01Z', type: 'outputs.snapshot', pr: 42, files: [{ path: '.agent-loop/plan.md', bytes: 10 }] },
    { ts: '2026-06-23T11:00:00Z', type: 'flow.status', from: 'in_progress', to: 'done' },
    { ts: '2026-06-23T11:00:00Z', type: 'flow.completed', step: 'review' },
  ];
  const stream = [serializeDoc(header), ...events.map(serializeDoc)].join('');

  it('preserves the header and the full ordered event sequence', () => {
    const tl = reconstructTimeline(stream);
    expect(tl.header).toEqual(header);
    expect(tl.events).toEqual(events);
  });

  it('folds the events into the run’s replayable final state', () => {
    const tl = reconstructTimeline(stream);
    expect(tl.flow).toEqual({ status: 'done', step: 'review' });
    expect(tl.ticket).toBe(17);
    expect(tl.pr).toBe(42);
    expect(tl.loop).toEqual({ status: 'building', iteration: 3 });
    expect(tl.inputs).toEqual({ ticket: '17' });
    expect(tl.commands).toEqual([{ source: 'bootstrap', cmd: 'agent-loop pickup 17', exit: 0 }]);
    expect(tl.snapshots).toEqual([{ pr: 42, files: [{ path: '.agent-loop/plan.md', bytes: 10 }] }]);
    // a1 ended done; a2 was deleted → only a1 survives.
    expect(tl.todos).toEqual([{ id: 'a1', text: 'Wire audit IPC', status: 'done' }]);
  });

  it('tolerates a trailing partial document (crash mid-append) and replays what survived', () => {
    const tl = reconstructTimeline(stream + '---\nts: 2026-06-23T11:01:00Z\ntype: "todo.cre');
    expect(tl.flow).toEqual({ status: 'done', step: 'review' });
    expect(tl.events).toEqual(events);
  });

  it('returns an empty, not-started timeline for an empty stream', () => {
    const tl = reconstructTimeline('');
    expect(tl.header).toBeNull();
    expect(tl.events).toEqual([]);
    expect(tl.flow).toEqual({ status: 'not_started', step: '' });
    expect(tl.todos).toEqual([]);
  });

  it('keeps the loop status when a loop.iteration arrives before any loop.status', () => {
    const h = serializeDoc(header);
    const iterFirst =
      h +
      serializeDoc({ ts: '2026-06-23T10:30:00Z', type: 'loop.iteration', n: 4 }) +
      serializeDoc({ ts: '2026-06-23T10:31:00Z', type: 'loop.status', from: '', to: 'building' });
    expect(reconstructTimeline(iterFirst).loop).toEqual({ status: 'building', iteration: 4 });
  });

  it('reads events even when the first document is not a valid header', () => {
    const headerless =
      serializeDoc({ ts: '2026-06-23T10:00:01Z', type: 'flow.started', step: 'plan' }) +
      serializeDoc({ ts: '2026-06-23T10:30:00Z', type: 'step.entered', step: 'build' });
    const parsed = parseAuditStream(headerless);
    expect(parsed.header).toBeNull();
    expect(parsed.events).toEqual([{ ts: '2026-06-23T10:30:00Z', type: 'step.entered', step: 'build' }]);
  });
});

describe('todoEvents — diff before/after the todo list (§25.5)', () => {
  const T = '2026-06-23T10:02:00Z';
  const todo = (id: string, text: string, status: TodoLike['status']): TodoLike => ({ id, text, status });

  it('emits todo.created for a newly added item', () => {
    expect(todoEvents([], [todo('a1', 'Wire audit IPC', 'active')], T)).toEqual([
      { ts: T, type: 'todo.created', id: 'a1', text: 'Wire audit IPC' },
    ]);
  });

  it('emits todo.status for a status change', () => {
    expect(todoEvents([todo('a1', 'x', 'active')], [todo('a1', 'x', 'in_progress')], T)).toEqual([
      { ts: T, type: 'todo.status', id: 'a1', from: 'active', to: 'in_progress' },
    ]);
  });

  it('emits todo.text for an edited body', () => {
    expect(todoEvents([todo('a1', 'x', 'active')], [todo('a1', 'y', 'active')], T)).toEqual([
      { ts: T, type: 'todo.text', id: 'a1', text: 'y' },
    ]);
  });

  it('emits todo.deleted for a removed item', () => {
    expect(todoEvents([todo('a1', 'x', 'active')], [], T)).toEqual([{ ts: T, type: 'todo.deleted', id: 'a1' }]);
  });

  it('emits nothing for a pure reorder (no id/text/status change)', () => {
    const a = todo('a1', 'x', 'active');
    const b = todo('b1', 'y', 'done');
    expect(todoEvents([a, b], [b, a], T)).toEqual([]);
  });
});
