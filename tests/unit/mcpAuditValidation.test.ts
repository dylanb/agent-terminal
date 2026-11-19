import { expect, it } from 'vitest';
import { dump } from 'js-yaml';
import { parseAuditStream } from '../../src/shared/audit';

it('stops replay at an invalid MCP origin instead of treating a list as human provenance', () => {
  const docs = [
    { flow: 'review', repo: 'fixture', repoPath: '/fixture', started: '2026-11-09T12:00:00Z' },
    { type: 'mcp.call', ts: '2026-11-09T12:00:01Z', mcp: { callId: 'call-1', tool: 'approve', outcome: 'taken', origin: ['human'] } },
    { type: 'flow.completed', ts: '2026-11-09T12:00:02Z', step: 'done' },
  ];
  expect(parseAuditStream(docs.map(doc => `---\n${dump(doc)}`).join(''))).toMatchObject({ events: [], incomplete: true });
});
