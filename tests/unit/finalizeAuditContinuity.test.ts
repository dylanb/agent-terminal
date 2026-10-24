import { describe, expect, it } from 'vitest';
import { reconstructTimeline, serializeDoc, type AuditEvent, type AuditHeader } from '../../src/shared/audit';

const header: AuditHeader = { flow: 'v3', repo: 'repo', repoPath: '/repo', started: '2026-10-24T10:00:00Z' };
const ts = '2026-10-24T10:01:00Z';
const stream = (events: AuditEvent[]) => serializeDoc(header) + events.map(serializeDoc).join('');

describe('audit history continuity', () => {
  it('attributes retained-item updates to later visits without rewriting earlier snapshots', () => {
    const result = reconstructTimeline(stream([
      { ts, type: 'flow.started', step: 'red' },
      { ts, type: 'todo.created', id: 'a', text: 'Complete later' },
      { ts, type: 'todo.created', id: 'b', text: 'Original question' },
      { ts, type: 'step.entered', step: 'green' },
      { ts, type: 'todo.status', id: 'a', from: 'active', to: 'done' },
      { ts, type: 'todo.text', id: 'b', text: 'Revised question' },
      { ts, type: 'step.entered', step: 'red' },
      { ts, type: 'todo.deleted', id: 'b' },
    ]));
    expect(result.visits).toMatchObject([
      { step: 'red', completedTodoCount: 0, unfinishedTodos: [
        { id: 'a', text: 'Complete later', deleted: false },
        { id: 'b', text: 'Original question', deleted: false },
      ] },
      { step: 'green', completedTodoCount: 1, unfinishedTodos: [
        { id: 'b', text: 'Revised question', deleted: false },
      ] },
      { step: 'red', completedTodoCount: 0, unfinishedTodos: [
        { id: 'b', text: 'Revised question', deleted: true },
      ] },
    ]);
  });

  const samples: AuditEvent[] = [
    { ts, type: 'flow.started', step: 'red' },
    { ts, type: 'flow.status', from: 'not_started', to: 'in_progress' },
    { ts, type: 'step.entered', step: 'green' },
    { ts, type: 'flow.completed', step: 'finalize' },
    { ts, type: 'flow.terminated' },
    { ts, type: 'todo.created', id: 'a', text: 'Task' },
    { ts, type: 'todo.status', id: 'a', from: 'active', to: 'done' },
    { ts, type: 'todo.text', id: 'a', text: 'Edited' },
    { ts, type: 'todo.deleted', id: 'a' },
    { ts, type: 'input.resolved', name: 'intent', value: 'Approved' },
    { ts, type: 'ticket.assoc', ticket: 251 },
    { ts, type: 'pr.assoc', pr: 41 },
    { ts, type: 'loop.status', from: '', to: 'working' },
    { ts, type: 'loop.iteration', n: 1 },
    { ts, type: 'command', source: 'gate', cmd: 'check', exit: null },
    { ts, type: 'outputs.snapshot', pr: null, files: [{ path: 'report.md', bytes: 20 }] },
    { ts, type: 'loop.cost', iteration: 1, usd: 0.1, unpriced: [] },
    { ts, type: 'loop.ci', iteration: 1, total: 2, passed: 1, failed: 0, pending: 1 },
    { ts, type: 'notify.failed', reason: 'Unavailable' },
  ];
  it.each(samples)('retains the valid prefix when $type is truncated but remains valid YAML', (event) => {
    const first: AuditEvent = { ts, type: 'flow.started', step: 'red' };
    const lines = serializeDoc(event).trimEnd().split('\n');
    // Remove the final required field, including any array children, as an interrupted append would.
    let lastField = lines.length - 1;
    while (/^\s/.test(lines[lastField])) lastField--;
    const truncated = lines.slice(0, lastField).join('\n') + '\n';
    const result = reconstructTimeline(stream([first]) + truncated);
    expect(result.coverage).toBe('incomplete');
    expect(result.events).toEqual([first]);
    expect(result.flow).toEqual({ status: 'in_progress', step: 'red' });
    expect(result.visits).toMatchObject([{ step: 'red', exited: null }]);
  });
});
