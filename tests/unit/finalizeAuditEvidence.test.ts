import { describe, expect, it } from 'vitest';
import { reconstructTimeline, serializeDoc, type AuditEvent, type AuditHeader } from '../../src/shared/audit';

const header: AuditHeader = { flow: 'feature-dev-v3', repo: 'project', repoPath: '/work/project', started: '2026-10-24T10:00:00Z' };
const at = (minute: number) => `2026-10-24T10:${String(minute).padStart(2, '0')}:00Z`;
const stream = (events: AuditEvent[]) => serializeDoc(header) + events.map(serializeDoc).join('');
const readForRun: (
  text: string,
  run: Pick<AuditHeader, 'repoPath' | 'flow' | 'started'>,
) => ReturnType<typeof reconstructTimeline> = reconstructTimeline;

describe('#251 report evidence from the shared audit reconstructor', () => {
  it('retains separate visits with elapsed intervals and an explicitly open final interval', () => {
    const timeline = reconstructTimeline(stream([
      { ts: at(0), type: 'flow.started', step: 'red' },
      { ts: at(2), type: 'step.entered', step: 'green' },
      { ts: at(5), type: 'step.entered', step: 'red' },
      { ts: at(9), type: 'step.entered', step: 'finalize' },
    ]));
    expect(timeline).toMatchObject({ visits: [
      { step: 'red', entered: at(0), exited: at(2), elapsedMs: 120000 },
      { step: 'green', entered: at(2), exited: at(5), elapsedMs: 180000 },
      { step: 'red', entered: at(5), exited: at(9), elapsedMs: 240000 },
      { step: 'finalize', entered: at(9), exited: null, elapsedMs: null },
    ] });
  });

  it('keeps completed counts and edited/deleted unfinished items attributable to their visit', () => {
    const timeline = reconstructTimeline(stream([
      { ts: at(0), type: 'flow.started', step: 'red' },
      { ts: at(1), type: 'todo.created', id: 'a', text: 'Check edge case' },
      { ts: at(2), type: 'todo.status', id: 'a', from: 'active', to: 'done' },
      { ts: at(3), type: 'todo.created', id: 'b', text: 'Draft question' },
      { ts: at(4), type: 'todo.text', id: 'b', text: 'Unresolved intent question' },
      { ts: at(5), type: 'todo.deleted', id: 'b' },
      { ts: at(6), type: 'step.entered', step: 'green' },
      { ts: at(7), type: 'step.entered', step: 'red' },
      { ts: at(8), type: 'todo.created', id: 'c', text: 'New regression' },
    ]));
    expect(timeline).toMatchObject({ visits: [
      { step: 'red', completedTodoCount: 1, unfinishedTodos: [{ id: 'b', text: 'Unresolved intent question', deleted: true }] },
      { step: 'green', completedTodoCount: 0, unfinishedTodos: [] },
      { step: 'red', completedTodoCount: 0, unfinishedTodos: [{ id: 'c', text: 'New regression', deleted: false }] },
    ] });
  });

  it('exposes a truncated stream as incomplete evidence while retaining its usable events', () => {
    const events: AuditEvent[] = [{ ts: at(0), type: 'flow.started', step: 'finalize' }];
    const timeline = reconstructTimeline(stream(events) + '---\nts: "unfinished');
    expect.soft(timeline).toMatchObject({ coverage: 'incomplete' });
    expect(timeline.events).toEqual(events);
    expect(timeline.flow.status).toBe('in_progress');
  });

  it('marks absent history unavailable rather than an observed empty successful run', () => {
    expect(reconstructTimeline('')).toMatchObject({ coverage: 'unavailable', header: null, events: [] });
  });

  it('does not classify a headerless stream as usable report evidence', () => {
    expect(reconstructTimeline(serializeDoc({ ts: at(0), type: 'flow.started', step: 'finalize' }))).toMatchObject({ coverage: 'unavailable' });
  });

  it.each([
    { repoPath: '/other/project', flow: header.flow, started: header.started },
    { repoPath: header.repoPath, flow: 'another-flow', started: header.started },
    { repoPath: header.repoPath, flow: header.flow, started: '2026-10-23T10:00:00Z' },
  ])('does not expose another run as evidence for %j', (run) => {
    const text = stream([{ ts: at(0), type: 'flow.started', step: 'finalize' }]);
    expect(readForRun(text, run)).toMatchObject({ coverage: 'unavailable', header: null, events: [] });
  });
});
