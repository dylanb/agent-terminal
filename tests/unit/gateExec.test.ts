import { describe, expect, it } from 'vitest';
import { interpolateExecArgv } from '../../src/main/gateExec';

// §26.6 — an `exec` gate action's argv carries `{{state.linked_issues[N]}}` + `{{artifact.<id>}}`
// placeholders resolved at execution time against the run's linked issues and the LoopDef artifact map.
// A half-resolvable argv (empty linked_issues, unknown artifact, unknown placeholder) yields null — the
// executor skips rather than run a `gh` with a literal `{{…}}` or an empty issue number.

const ARGV = ['gh', 'issue', 'edit', '{{state.linked_issues[0]}}', '--body-file', '{{artifact.ticket-body}}'];

function ctx(overrides: Partial<{ linkedIssues: number[]; resolveArtifact: (id: string) => string | null }> = {}) {
  return {
    linkedIssues: [42],
    resolveArtifact: (id: string) => (id === 'ticket-body' ? '/repo/.agent-loop/ticket.md' : null),
    ...overrides,
  };
}

describe('interpolateExecArgv (§26.6 exec placeholder resolution)', () => {
  it('substitutes linked_issues[N] and artifact.<id>, leaving literals untouched', () => {
    expect(interpolateExecArgv(ARGV, ctx())).toEqual([
      'gh',
      'issue',
      'edit',
      '42',
      '--body-file',
      '/repo/.agent-loop/ticket.md',
    ]);
  });

  it('resolves a placeholder embedded within a larger argv element', () => {
    expect(interpolateExecArgv(['--body-file={{artifact.ticket-body}}'], ctx())).toEqual([
      '--body-file=/repo/.agent-loop/ticket.md',
    ]);
  });

  it('returns null when a linked_issues index is out of range', () => {
    expect(interpolateExecArgv(ARGV, ctx({ linkedIssues: [] }))).toBeNull();
  });

  it('returns null when an artifact id does not resolve', () => {
    expect(interpolateExecArgv(['{{artifact.no-such}}'], ctx())).toBeNull();
  });

  it('returns null on an unrecognized placeholder', () => {
    expect(interpolateExecArgv(['{{env.SECRET}}'], ctx())).toBeNull();
  });

  it('passes an argv with no placeholders through unchanged', () => {
    expect(interpolateExecArgv(['gh', 'pr', 'ready', '7'], ctx())).toEqual(['gh', 'pr', 'ready', '7']);
  });
});
