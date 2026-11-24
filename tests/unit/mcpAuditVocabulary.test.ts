import { expect, it } from 'vitest';
import { dump } from 'js-yaml';
import { parseAuditStream, reconstructTimeline } from '../../src/shared/audit';

const header = { flow: 'review', repo: 'fixture', repoPath: '/fixture', started: '2026-11-09T12:00:00Z' };
const ts = '2026-11-09T12:00:01Z';
const stream = (...documents: unknown[]): string => documents.map(doc => `---\n${dump(doc)}`).join('');

it('reads human prompt text and identity without losing later legacy events', () => {
  const prompt = { type: 'mcp.prompt', ts, id: 'prompt-1', text: 'first line\nsecond: λ' };
  const started = { type: 'flow.started', ts, step: 'review' };
  expect(parseAuditStream(stream(header, prompt, started))).toMatchObject({ header, events: [prompt, started], incomplete: false });
});

it('retains call origin, result and prompt linkage on both new and existing events', () => {
  const mcp = { callId: 'call-1', tool: 'todo_create', outcome: 'created', origin: 'human', promptId: 'prompt-1' };
  const created = { type: 'todo.created', ts, id: 'todo-1', text: 'task', mcp };
  const refused = { type: 'mcp.call', ts, mcp: { callId: 'call-2', tool: 'approve', outcome: 'origin-undetermined', origin: 'undetermined', reason: 'Turn origin could not be determined' } };
  expect(parseAuditStream(stream(header, created, refused))).toMatchObject({ events: [created, refused], incomplete: false });
});

it('reads delivery results and keeps them separate from their send call', () => {
  const submitted = { type: 'mcp.delivery', ts, sendId: 'send-1', outcome: 'submitted' };
  const dropped = { type: 'mcp.delivery', ts, sendId: 'send-2', outcome: 'dropped', reason: 'calling session ended' };
  expect(parseAuditStream(stream(header, submitted, dropped))).toMatchObject({ events: [submitted, dropped], incomplete: false });
});

it('replays old records without adding MCP provenance or changing their flow and todo state', () => {
  const events = [{ type: 'flow.started', ts, step: 'review' }, { type: 'todo.created', ts, id: 'old-todo', text: 'legacy task' }, { type: 'flow.completed', ts, step: 'done' }];
  const text = stream(header, ...events);
  expect(parseAuditStream(text)).toMatchObject({ header, events, incomplete: false });
  expect(reconstructTimeline(text)).toMatchObject({ coverage: 'complete', todos: [{ id: 'old-todo', text: 'legacy task', status: 'active' }] });
});
