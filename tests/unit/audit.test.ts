import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  auditFileStamp,
  auditTimestamp,
  chainedTransitionAuditCmd,
  appBootstrapAuditCmd,
  appBootstrapAuditExit,
  inputEvents,
  lifecycleEvents,
  consolidateAuditCmd,
  autoHaltAuditCmd,
  epicPromotionAuditCmd,
  gateDecisionAuditCmd,
  gateDecisionDecider,
  gateDecisionKind,
  parseAutoHaltReasons,
  loopEvents,
  parseAuditStream,
  reconstructTimeline,
  reviewRoundAuditCmd,
  serializeDoc,
  stepWindowEvents,
  terminateEvents,
  todoEvents,
  type AuditEvent,
  type AuditHeader,
  type TodoLike,
} from '../../src/shared/audit';
import { auditFileName, auditFilePath, auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { GATE_DECISION_OPTIONS } from '../../src/shared/ipc';

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
  it('two Starts in one repo at timestamps in different seconds resolve to two distinct files', () => {
    const first = auditFilePath('/root', '/a/b/repo', 'feature-dev', new Date('2026-06-23T10:00:01.900Z'));
    const second = auditFilePath('/root', '/a/b/repo', 'feature-dev', new Date('2026-06-23T10:00:02.100Z'));
    expect(first).not.toBe(second);
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

describe('loopEvents — diff the §27 loop view (§25.5)', () => {
  const T = '2026-06-23T10:30:00Z';
  const loop = (status: string, iteration: number, pr: number | null) => ({ status, iteration, pr });

  it('records the initial status, iteration, and PR on first observation (no prior)', () => {
    expect(loopEvents(null, loop('planning', 1, null), T)).toEqual([
      { ts: T, type: 'loop.status', from: '', to: 'planning' },
      { ts: T, type: 'loop.iteration', n: 1 },
    ]);
  });

  it('associates the PR the first time the view carries one', () => {
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

  it('records the status but NO iteration event when no round has run (a §27 run-less view)', () => {
    expect(loopEvents(null, { status: 'not-started', iteration: undefined, pr: null }, T)).toEqual([
      { ts: T, type: 'loop.status', from: '', to: 'not-started' },
    ]);
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

  // §25 — a per-iteration cost event folds into an ordered costs list for the run.
  it('folds loop.cost events into the run’s costs list (§25)', () => {
    const h = serializeDoc(header);
    const withCosts =
      h +
      serializeDoc({ ts: '2026-06-23T10:30:00Z', type: 'loop.cost', iteration: 1, usd: 0.1, unpriced: [] }) +
      serializeDoc({ ts: '2026-06-23T10:40:00Z', type: 'loop.cost', iteration: 2, usd: 0.42, unpriced: ['x-unknown'] });
    expect(reconstructTimeline(withCosts).costs).toEqual([
      { iteration: 1, usd: 0.1, unpriced: [] },
      { iteration: 2, usd: 0.42, unpriced: ['x-unknown'] },
    ]);
  });

  // §25 — a per-iteration CI snapshot event folds into an ordered ci list for the run.
  it('folds loop.ci events into the run’s ci list (§25)', () => {
    const h = serializeDoc(header);
    const withCi =
      h +
      serializeDoc({ ts: '2026-06-23T10:30:00Z', type: 'loop.ci', iteration: 1, total: 3, passed: 1, failed: 0, pending: 2 }) +
      serializeDoc({ ts: '2026-06-23T10:40:00Z', type: 'loop.ci', iteration: 2, total: 3, passed: 3, failed: 0, pending: 0 });
    expect(reconstructTimeline(withCi).ci).toEqual([
      { iteration: 1, total: 3, passed: 1, failed: 0, pending: 2 },
      { iteration: 2, total: 3, passed: 3, failed: 0, pending: 0 },
    ]);
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

// Terminate (#26 / §25): a deliberately-abandoned run gets a timestamped termination event, distinct
// from the lifecycle transitions, from which the reconstructed timeline reads not_started again.
describe('terminate classifier + timeline fold (§25 / #26 AC8)', () => {
  const T = '2026-06-23T10:00:01Z';

  it('emits a single timestamped flow.terminated event', () => {
    expect(terminateEvents(T)).toEqual([{ ts: T, type: 'flow.terminated' }]);
  });

  it('reconstructs a terminated run as not_started with no step', () => {
    const stream =
      serializeDoc({ flow: 'feature-dev', repo: 'r', repoPath: '/r', started: T }) +
      serializeDoc({ ts: T, type: 'flow.started', step: 'plan' }) +
      serializeDoc(terminateEvents(T)[0]);
    const tl = reconstructTimeline(stream);
    expect(tl.flow).toEqual({ status: 'not_started', step: '' });
    expect(tl.events.map((e) => e.type)).toEqual(['flow.started', 'flow.terminated']);
  });
});

// §27.5/§27.12 — the review-and-fix round's boundary/complete/error/accept/retry commands get ONE
// definition here (the shared audit vocabulary), never ad-hoc main-process strings, so the writer and any
// future reader/viewer cannot re-spell them.
describe('§27 review-round audit vocabulary', () => {
  it('builds round-keyed command text carrying the round and any detail', () => {
    expect(reviewRoundAuditCmd('boundary', 1, '/compact keep')).toContain('round 1');
    expect(reviewRoundAuditCmd('boundary', 1, '/compact keep')).toContain('/compact keep');
    expect(reviewRoundAuditCmd('complete', 2)).toContain('round 2');
    expect(reviewRoundAuditCmd('error', 1, 'report omits a roster persona')).toContain('report omits a roster persona');
    expect(reviewRoundAuditCmd('accept', 1)).toContain('accept');
    expect(reviewRoundAuditCmd('retry', 3)).toContain('round 3');
  });
});

// §27.9/§27.13 / N5 — the human-gate decision audit vocabulary lives in this ONE shared module beside the
// round/consolidate ones (CLAUDE.md single-home rule), so the writer and a future viewer read the same phrases.
describe('§27 gate-decision audit vocabulary', () => {
  it('builds command text carrying the option and the side-effect outcome, distinguishing success from failure', () => {
    expect(gateDecisionAuditCmd('decision', 'approve')).toContain('approve');
    const ok = gateDecisionAuditCmd('side-effect', 'approve', 'mark-ready');
    expect(ok).toContain('approve');
    expect(ok).toContain('mark-ready');
    const failed = gateDecisionAuditCmd('side-effect-failed', 'approve', 'mark-ready: no PR to mark ready');
    expect(failed).toContain('no PR to mark ready');
    // A recorded failure is distinguishable from a success for the same action (§27.13 / AC3).
    expect(failed).not.toBe(gateDecisionAuditCmd('side-effect', 'approve', 'mark-ready'));
    // §27.9/AC4 — a request-changes the engine could not start is recorded as a DROP, distinct from the decision
    // that ran, so the audit never claims a round that never happened.
    const dropped = gateDecisionAuditCmd('decision-dropped', 'request-changes', 'the loop was busy');
    expect(dropped).toContain('request-changes');
    expect(dropped).toContain('the loop was busy');
    expect(dropped).not.toBe(gateDecisionAuditCmd('decision', 'request-changes'));
    // §27.9/AC6 — an approve whose best-effort polish cleanup threw AFTER the accept persisted is recorded as a
    // clear-polish failure, distinct from the decision that succeeded, so the accept is never read as aborted.
    const clearFailed = gateDecisionAuditCmd('clear-polish-failed', 'approve', 'EISDIR: illegal operation on a directory');
    expect(clearFailed).toContain('approve');
    expect(clearFailed).toContain('EISDIR');
    expect(clearFailed).not.toBe(gateDecisionAuditCmd('decision', 'approve'));
  });

  // §28.3 / T-taint — an untrusted detail (a def-supplied action / commit phase label) is neutralized
  // before it lands in the append-only §25 stream (CWE-117): control chars stripped, length bounded.
  it('neutralizes control chars and bounds the length of an untrusted detail', () => {
    const evil = 'commit: RED\n\r\x1b[31mfake failed\x07\x00';
    const out = gateDecisionAuditCmd('side-effect', 'approve', evil);
    const hasControlChar = [...out].some((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0x1f || c === 0x7f;
    });
    expect(hasControlChar).toBe(false); // no control chars reach the append-only stream
    const long = 'x'.repeat(1000);
    expect(gateDecisionAuditCmd('side-effect', 'approve', long).length).toBeLessThan(400); // bounded
  });

  // §28.3 / T13b — a benign nothing-to-commit is a DISTINCT outcome from a real failure, so a reader (a
  // reconstructed timeline) never mistakes an empty phase for a `git commit` error.
  it('records a benign skipped side-effect distinctly from a success and a failure', () => {
    const skipped = gateDecisionAuditCmd('side-effect-skipped', 'approve', 'commit: nothing to commit');
    expect(skipped).toContain('approve');
    expect(skipped).toContain('skipped');
    expect(skipped).not.toBe(gateDecisionAuditCmd('side-effect-failed', 'approve', 'commit: nothing to commit'));
    expect(skipped).not.toBe(gateDecisionAuditCmd('side-effect', 'approve', 'commit: nothing to commit'));
  });
});

// §27.10/§27.9 / N6 — the chained-transition audit vocabulary lives in this ONE shared module beside the
// round/consolidate/gate ones (CLAUDE.md single-home rule), so the main-process writer and a future viewer
// read the same phrase for "an approved loop's output was carried into the next loop's work turn".
describe('§27 chained-transition audit vocabulary', () => {
  it('builds command text naming the entered step and the carried input artifact ids', () => {
    const cmd = chainedTransitionAuditCmd('implement', ['plan']);
    expect(cmd).toContain('implement'); // the step the artifact chained INTO
    expect(cmd).toContain('plan'); // the resolved input artifact id carried in
  });

  it('lists every carried artifact id when more than one input chains in', () => {
    const cmd = chainedTransitionAuditCmd('implement', ['plan', 'design-notes']);
    expect(cmd).toContain('plan');
    expect(cmd).toContain('design-notes');
  });

  it('a transition into one step is distinguishable from the same artifact into another (§6 identity)', () => {
    expect(chainedTransitionAuditCmd('implement', ['plan'])).not.toBe(chainedTransitionAuditCmd('plan', ['plan']));
  });

  it('names a declared input that did not chain, so a broken chain is not read as a loop declaring none', () => {
    const cmd = chainedTransitionAuditCmd('implement', ['plan'], ['groomed-ticket']);
    expect(cmd).toContain('plan');
    expect(cmd).toContain('groomed-ticket');
    // A chain that carried everything it declared must not read the same as one that dropped an input.
    expect(cmd).not.toBe(chainedTransitionAuditCmd('implement', ['plan'], []));
  });

  it('names an empty carried list explicitly rather than leaving a blank slot a reader parses as an id', () => {
    // Live case: a step declares inputs and carries none. A dangling `: ` splits to [''] — one artifact whose
    // id is the empty string — which is exactly the writer↔reader desync the shared vocabulary exists to stop.
    const cmd = chainedTransitionAuditCmd('implement', [], ['plan']);
    expect(cmd).not.toMatch(/:\s*\(declared/); // no blank slot where the carried ids belong
    // `none` is a legal binding id (`^[a-z0-9][a-z0-9-]*$`), so a sentinel drawn from that grammar makes one
    // carried artifact byte-identical to zero — the same reader ambiguity, relocated rather than removed.
    expect(cmd).not.toBe(chainedTransitionAuditCmd('implement', ['none'], ['plan']));
  });
});

describe('§27 bootstrap audit vocabulary', () => {
  it('distinguishes the step-keyed lifecycle outcomes and carries failure detail', () => {
    expect(appBootstrapAuditCmd('start', 'plan')).toContain('plan');
    expect(appBootstrapAuditCmd('success', 'plan', 'plan-loop/issue-78')).toContain('plan-loop/issue-78');
    expect(appBootstrapAuditCmd('failure', 'plan', 'working tree is not clean')).toContain('working tree is not clean');
    expect(appBootstrapAuditCmd('conflict', 'plan', 'plan-loop/issue-78')).toContain('conflict');
    expect(appBootstrapAuditCmd('wipe', 'plan', 'plan-loop/issue-78')).toContain('wipe confirmed');
    expect(appBootstrapAuditCmd('decline', 'plan', 'plan-loop/issue-78')).toContain('wipe declined');
    expect(appBootstrapAuditCmd('wipe', 'plan')).not.toBe(appBootstrapAuditCmd('decline', 'plan'));
    expect(appBootstrapAuditCmd('rollback', 'plan')).not.toBe(appBootstrapAuditCmd('failure', 'plan'));
    expect(appBootstrapAuditCmd('rollback-failed', 'plan', 'EACCES')).not.toMatch(/rolled back/);
    expect(appBootstrapAuditCmd('rollback-failed', 'plan', 'EACCES')).toContain('EACCES');
    expect(appBootstrapAuditExit('rollback-failed')).toBe(1);
    expect(appBootstrapAuditCmd('stale', 'plan')).not.toBe(appBootstrapAuditCmd('success', 'plan'));
  });

  // The exit each kind records lives beside the vocabulary it classifies, not at the one call site: this
  // diff widened the union by three and the caller's mapping was a closed expression with a catch-all,
  // so a declined wipe — an answer — and a completed one were both recorded as failed commands.
  it('records an outcome only for the kinds that are one', () => {
    expect(appBootstrapAuditExit('success')).toBe(0);
    expect(appBootstrapAuditExit('wipe')).toBe(0);
    expect(appBootstrapAuditExit('decline')).toBe(0);
    expect(appBootstrapAuditExit('failure')).toBe(1);
    expect(appBootstrapAuditExit('rollback')).toBe(1);
    // Not outcomes: begun, awaiting the operator, and superseded.
    expect(appBootstrapAuditExit('start')).toBeNull();
    expect(appBootstrapAuditExit('conflict')).toBeNull();
    expect(appBootstrapAuditExit('stale')).toBeNull();
  });
});

// §27.6/§25 — the consolidator-turn audit vocabulary lives in this ONE shared module beside the review-round
// one (CLAUDE.md single-home rule), so the main-process writer and a future viewer read the same phrases.
describe('§27 consolidate-turn audit vocabulary', () => {
  it('builds round-keyed command text carrying the round, the verdict/detail, and a DISTINCT interrupt event', () => {
    expect(consolidateAuditCmd('boundary', 1, '/compact keep')).toContain('round 1');
    expect(consolidateAuditCmd('boundary', 1, '/compact keep')).toContain('/compact keep');
    expect(consolidateAuditCmd('complete', 2, 'clean')).toContain('round 2');
    expect(consolidateAuditCmd('complete', 2, 'clean')).toContain('clean');
    expect(consolidateAuditCmd('error', 1, 'malformed verdict')).toContain('malformed verdict');
    expect(consolidateAuditCmd('accept', 1)).toContain('accept');
    expect(consolidateAuditCmd('retry', 3)).toContain('round 3');
    // AC9 — an honored armed interrupt records its own event, distinguishable from a terminal `complete`.
    const interrupt = consolidateAuditCmd('interrupt', 2, 'another round');
    expect(interrupt).toContain('interrupt');
    expect(interrupt).toContain('another round');
    expect(interrupt).not.toBe(consolidateAuditCmd('complete', 2, 'another round'));
  });
});

// §27 IPC item 3 / AC8 — the round number flows through the SHARED audit vocabulary the loop-view diff
// already emits: a first-present round (iteration absent → 1) records loop.iteration n:1, never a fabricated
// 0, and the reconstructed timeline carries the round across a completed-then-errored review round.
describe('§27 round number flows through loopEvents without coalescing to zero (AC8)', () => {
  const T = '2026-07-18T00:00:00Z';

  it('emits loop.iteration n:1 for the first present round (absent → 1)', () => {
    const events = loopEvents({ status: 'working', pr: null }, { status: 'working', iteration: 1, pr: null }, T);
    expect(events).toContainEqual({ ts: T, type: 'loop.iteration', n: 1 });
  });

  it('carries the round through a completed-then-errored review round in the reconstructed timeline', () => {
    const stream =
      serializeDoc({ flow: 'plan-loop', repo: 'r', repoPath: '/r', started: T }) +
      serializeDoc({ ts: T, type: 'loop.status', from: '', to: 'working' }) +
      serializeDoc({ ts: T, type: 'loop.iteration', n: 1 }) +
      serializeDoc({ ts: T, type: 'loop.status', from: 'working', to: 'error' });
    expect(reconstructTimeline(stream).loop).toEqual({ status: 'error', iteration: 1 });
  });
});

describe('stepWindowEvents — the events of a step\'s last (re)entry window', () => {
  const inProg = (stepName: string) => ({ status: 'in_progress' as const, stepName });
  const done = (stepName: string) => ({ status: 'done' as const, stepName });
  const notStarted = { status: 'not_started' as const, stepName: '' };
  const gate = (cmd: string, ts = 'T'): AuditEvent => ({ ts, type: 'command', source: 'gate', cmd, exit: 0 });
  const header: AuditHeader = { flow: 'f', repo: 'r', repoPath: '/r', started: 'T0' };
  const read = (events: AuditEvent[]) =>
    parseAuditStream([header, ...events].map(serializeDoc).join('')).events;
  const gateCmds = (events: AuditEvent[]) =>
    events.flatMap((e) => (e.type === 'command' && e.source === 'gate' ? [e.cmd] : []));

  it("finds a single-step run's gate commands by its first step, which Start enters with no step.entered", () => {
    const events = read([
      ...lifecycleEvents('start', notStarted, inProg('red'), 'T1'),
      gate('decision approve'),
      ...lifecycleEvents('advance', inProg('red'), done('red'), 'T2'),
    ]);
    expect(gateCmds(stepWindowEvents(events, 'red'))).toEqual(['decision approve']);
  });

  it('scopes a two-step run to each step', () => {
    const events = read([
      ...lifecycleEvents('start', notStarted, inProg('red'), 'T1'),
      gate('red gate'),
      ...lifecycleEvents('advance', inProg('red'), inProg('green'), 'T2'),
      gate('green gate'),
      ...lifecycleEvents('advance', inProg('green'), done('green'), 'T3'),
    ]);
    expect(gateCmds(stepWindowEvents(events, 'red'))).toEqual(['red gate']);
    expect(gateCmds(stepWindowEvents(events, 'green'))).toEqual(['green gate']);
  });

  it('keeps only the restarted run after a Restart from done', () => {
    const events = read([
      ...lifecycleEvents('start', notStarted, inProg('red'), 'T1'),
      gate('first run'),
      ...lifecycleEvents('advance', inProg('red'), done('red'), 'T2'),
      ...lifecycleEvents('restart', done('red'), inProg('red'), 'T3'),
      gate('restarted run'),
    ]);
    expect(gateCmds(stepWindowEvents(events, 'red'))).toEqual(['restarted run']);
  });

  it('a Restart from done that re-enters the first step leaves the last step its earlier window', () => {
    const events = read([
      ...lifecycleEvents('start', notStarted, inProg('red'), 'T1'),
      ...lifecycleEvents('advance', inProg('red'), inProg('green'), 'T2'),
      gate('green gate'),
      ...lifecycleEvents('advance', inProg('green'), done('green'), 'T3'),
      ...lifecycleEvents('restart', done('green'), inProg('red'), 'T4'),
      gate('restarted red'),
    ]);
    expect(gateCmds(stepWindowEvents(events, 'green'))).toEqual(['green gate']);
    expect(gateCmds(stepWindowEvents(events, 'red'))).toEqual(['restarted red']);
  });

  it('an Undo from done re-enters the step it stays on', () => {
    const events = read([
      ...lifecycleEvents('start', notStarted, inProg('red'), 'T1'),
      gate('before undo'),
      ...lifecycleEvents('advance', inProg('red'), done('red'), 'T2'),
      ...lifecycleEvents('undo', done('red'), inProg('red'), 'T3'),
      gate('after undo'),
    ]);
    expect(gateCmds(stepWindowEvents(events, 'red'))).toEqual(['after undo']);
  });

  it('throws naming a step no boundary enters, so an empty read never satisfies a "none" assertion', () => {
    const events = read([...lifecycleEvents('start', notStarted, inProg('red'), 'T1'), gate('g')]);
    expect(() => stepWindowEvents(events, 'refactor')).toThrow(/refactor/);
  });
});

// §27.9.1 N9b.9 (#137 AC7/AC8) — who decided a gate, and why an `auto` gate halted, read back from §25.
describe('gate-decision entries carry the deciding party (N9b.9)', () => {
  // Pinning: the human strings are the §25 entries as written before #137, captured at 8f03f066.
  const HUMAN_LITERALS: [Parameters<typeof gateDecisionAuditCmd>[0], string | undefined, string][] = [
    ['decision', undefined, '§27 gate approve'],
    ['decision-dropped', 'the loop was busy', '§27 gate approve dropped: the loop was busy'],
    ['side-effect', 'commit: RED', '§27 gate approve side-effect: commit: RED'],
    ['side-effect-skipped', 'commit: nothing to commit', '§27 gate approve side-effect skipped: commit: nothing to commit'],
    ['side-effect-failed', 'mark-ready: no PR', '§27 gate approve side-effect failed: mark-ready: no PR'],
    ['accept-failed', 'EACCES', '§27 gate approve accept failed: EACCES'],
    ['clear-polish-failed', 'EISDIR', '§27 gate approve clear-polish failed: EISDIR'],
    ['baseline-record-failed', 'EIO', '§27 gate approve baseline-record failed: EIO'],
    ['source-slices-failed', 'bad plan', '§28 gate approve source-slices failed: bad plan'],
    ['clear-brief-failed', 'ENOENT', '§28 gate approve clear-brief failed: ENOENT'],
    ['epic-promotion-preview', undefined, '§28 gate approve epic-promotion preview raised'],
  ];

  it.each(HUMAN_LITERALS)('pinning: a human %s entry is byte-for-byte the pre-#137 string', (kind, detail, literal) => {
    expect(gateDecisionAuditCmd(kind, 'approve', detail, 'human')).toBe(literal);
  });

  it.each(HUMAN_LITERALS)('an engine-decided %s entry carries the mark right after the option', (kind, detail, literal) => {
    const marked = literal.replace(/^(§2[78] gate approve)/, '$1 (engine-decided)');
    expect(gateDecisionAuditCmd(kind, 'approve', detail, 'engine')).toBe(marked);
  });

  it.each(HUMAN_LITERALS)('reads back who decided a %s entry, in both directions', (kind, detail) => {
    expect(gateDecisionDecider(gateDecisionAuditCmd(kind, 'approve', detail, 'engine'))).toBe('engine');
    expect(gateDecisionDecider(gateDecisionAuditCmd(kind, 'approve', detail, 'human'))).toBe('human');
  });

  it('classifies every kind under every option and both deciders', () => {
    for (const option of GATE_DECISION_OPTIONS) {
      for (const decider of ['human', 'engine'] as const) {
        for (const [kind, detail] of HUMAN_LITERALS) {
          const cmd = gateDecisionAuditCmd(kind, option, detail, decider);
          expect(gateDecisionKind(cmd)).toEqual({ family: 'gate', kind, option });
          expect(gateDecisionDecider(cmd)).toBe(decider);
        }
      }
    }
  });

  it('a human entry whose untrusted detail spells the mark still reads human, with no halt reasons', () => {
    const cmd = gateDecisionAuditCmd('side-effect', 'approve', 'commit: x (engine-decided) halted: a — y', 'human');
    expect(gateDecisionDecider(cmd)).toBe('human');
    expect(gateDecisionKind(cmd)).toEqual({ family: 'gate', kind: 'side-effect', option: 'approve' });
    expect(parseAutoHaltReasons(cmd)).toBeNull();
  });

  it('reads no decider from a non-gate command', () => {
    expect(gateDecisionDecider('§27 consolidate round 1 verdict clean')).toBeNull();
  });
});

describe('epic-promotion entries carry the deciding party (N9b.9)', () => {
  // The literals the coordinator writes, pinned in epicPromotion.test.ts.
  it('every human epic-promotion entry is byte-for-byte the coordinator\'s pre-#137 string', () => {
    expect(epicPromotionAuditCmd('blocked', 'unreadable promotion record', 'human')).toBe('§28 epic-promotion blocked — unreadable promotion record');
    expect(epicPromotionAuditCmd('declined', undefined, 'human')).toBe('§28 epic-promotion declined');
    expect(epicPromotionAuditCmd('confirm', undefined, 'human')).toBe('§28 epic-promotion');
    expect(epicPromotionAuditCmd('terminate-failed', 'locked', 'human')).toBe('§28 epic-promotion terminate failed: locked');
  });

  it('an engine-decided blocked entry is marked, and every epic entry reads back its kind and decider', () => {
    const blocked = epicPromotionAuditCmd('blocked', 'unresolvable epic issue', 'engine');
    expect(blocked).toBe('§28 epic-promotion (engine-decided) blocked — unresolvable epic issue');
    expect(gateDecisionDecider(blocked)).toBe('engine');
    expect(gateDecisionKind(blocked)).toEqual({ family: 'epic-promotion', kind: 'blocked' });
    const confirm = epicPromotionAuditCmd('confirm', undefined, 'human');
    expect(gateDecisionDecider(confirm)).toBe('human');
    expect(gateDecisionKind(confirm)).toEqual({ family: 'epic-promotion', kind: 'confirm' });
    expect(gateDecisionKind(epicPromotionAuditCmd('declined', undefined, 'human'))).toEqual({ family: 'epic-promotion', kind: 'declined' });
    expect(gateDecisionKind(epicPromotionAuditCmd('terminate-failed', 'x', 'engine'))).toEqual({ family: 'epic-promotion', kind: 'terminate-failed' });
  });
});

describe('auto-halt entries name every reason that holds (N9b.9)', () => {
  const ALL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'stop-for-a-human'] as const;
  const header: AuditHeader = { flow: 'f', repo: 'r', repoPath: '/r', started: 'T0' };

  it('round-trips a halt naming all 13 reasons through serialize ↔ parse, as an engine-decided exit-0 gate entry', () => {
    const cmd = autoHaltAuditCmd(ALL.map((reason) => ({ reason })));
    const event: AuditEvent = { ts: 'T1', type: 'command', source: 'gate', cmd, exit: 0 };
    const [read] = reconstructTimeline([header, event].map(serializeDoc).join('')).commands;
    expect(read.exit).toBe(0);
    expect(parseAutoHaltReasons(read.cmd)).toEqual([...ALL]);
    expect(gateDecisionDecider(read.cmd)).toBe('engine');
    expect(gateDecisionKind(read.cmd)).toEqual({ family: 'gate', kind: 'auto-halt' });
  });

  it('writes the verdict halt as the one stop-for-a-human token', () => {
    expect(parseAutoHaltReasons(autoHaltAuditCmd([{ reason: 'stop-for-a-human' }]))).toEqual(['stop-for-a-human']);
  });

  it('de-duplicates reasons in the closed-set order, whatever order they were given', () => {
    expect(parseAutoHaltReasons(autoHaltAuditCmd([{ reason: 'g' }, { reason: 'c' }, { reason: 'g', detail: 'x' }]))).toEqual(['c', 'g']);
  });

  it('keeps every letter when untrusted details overflow the bounded tail', () => {
    const cmd = autoHaltAuditCmd(ALL.map((reason) => ({ reason, detail: 'z'.repeat(500) })));
    expect(parseAutoHaltReasons(cmd)).toEqual([...ALL]);
  });

  // CWE-117 — the same neutralization `gateDecisionAuditCmd` applies to its untrusted detail.
  it('neutralizes control chars in untrusted details and bounds the whole tail', () => {
    const reasons = [
      { reason: 'a' as const, detail: 'gh: \x1b[31mfake failed\r\n\x07\x00\x9b' },
      { reason: 'b' as const, detail: 'y'.repeat(5000) },
    ];
    const cmd = autoHaltAuditCmd(reasons);
    const bare = autoHaltAuditCmd(reasons.map(({ reason }) => ({ reason })));
    expect(parseAutoHaltReasons(cmd)).toEqual(['a', 'b']);
    expect(cmd).toContain('fake failed');
    expect([...cmd].some((ch) => {
      const c = ch.charCodeAt(0);
      return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
    })).toBe(false);
    expect(cmd.length).toBeLessThan(bare.length + 400);
  });

  it('reads no reason out of an untrusted detail that spells other reasons', () => {
    const cmd = autoHaltAuditCmd([{ reason: 'c', detail: 'halted: a, g — b (engine-decided) halted: stop-for-a-human' }]);
    expect(parseAutoHaltReasons(cmd)).toEqual(['c']);
  });

  it('reads no reasons from a decision entry', () => {
    expect(parseAutoHaltReasons(gateDecisionAuditCmd('decision', 'approve', undefined, 'engine'))).toBeNull();
  });
});
