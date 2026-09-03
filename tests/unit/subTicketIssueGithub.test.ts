import { describe, expect, it } from 'vitest';
import { parseIssueBodyLabels } from '../../src/main/subTicketIssueGithub';

// §27.10 N10 — `gh issue view --json body,labels` output is untrusted JSON; the reader normalizes gh's
// `labels: [{name}]` to a flat string[] and a missing body to '' so the pickup classifier reads one clean shape.
describe('§27.10 parseIssueBodyLabels', () => {
  it('normalizes gh labels [{name}] to a flat string[] and keeps the body', () => {
    const out = JSON.stringify({ body: 'the slice body', labels: [{ name: 'agent-loop/subticket' }, { name: 'agent-loop/ready' }] });
    expect(parseIssueBodyLabels(out)).toEqual({ body: 'the slice body', labels: ['agent-loop/subticket', 'agent-loop/ready'] });
  });

  it('reads a missing body as empty and missing labels as none', () => {
    expect(parseIssueBodyLabels(JSON.stringify({}))).toEqual({ body: '', labels: [] });
  });

  it('drops label entries without a string name', () => {
    const out = JSON.stringify({ body: 'x', labels: [{ name: 'keep' }, { color: 'red' }, 'not-an-object'] });
    expect(parseIssueBodyLabels(out)).toEqual({ body: 'x', labels: ['keep'] });
  });

  it('returns null on non-JSON or a non-object payload', () => {
    expect(parseIssueBodyLabels('not json')).toBeNull();
    expect(parseIssueBodyLabels('[1,2,3]')).toBeNull();
  });
});
