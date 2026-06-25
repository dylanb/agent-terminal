import { describe, expect, it } from 'vitest';
import { matchBootstrapCommands, type FinishedSpan, type PendingBootstrap } from '../../src/main/bootstrapCommands';

const span = (id: string, command: string, exitCode: number | null, running = false): FinishedSpan => ({
  id,
  command,
  exitCode,
  running,
});

describe('matchBootstrapCommands — correlate an injected bootstrap with its OSC-133 span exit (§25.5)', () => {
  it('matches a finished span to a pending bootstrap and carries the exit code', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    const matches = matchBootstrapCommands(pending, [span('s1', 'agent-loop pickup 176', 127)], new Set());
    expect(matches).toEqual([{ spanId: 's1', repoKey: '/r', cmd: 'agent-loop pickup 176', exit: 127 }]);
  });

  it('ignores a still-running span (no exit yet)', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    expect(matchBootstrapCommands(pending, [span('s1', 'agent-loop pickup 176', null, true)], new Set())).toEqual([]);
  });

  it('does not re-match a span already recorded', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    expect(matchBootstrapCommands(pending, [span('s1', 'agent-loop pickup 176', 0)], new Set(['s1']))).toEqual([]);
  });

  it('matches a span whose extracted text has surrounding whitespace', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    const matches = matchBootstrapCommands(pending, [span('s1', '  agent-loop pickup 176  ', 0)], new Set());
    expect(matches.map((m) => m.spanId)).toEqual(['s1']);
  });

  it('does not mis-match a pending command that is a token-prefix of a longer span command', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 17' }];
    expect(matchBootstrapCommands(pending, [span('s1', 'agent-loop pickup 176', 0)], new Set())).toEqual([]);
  });

  it('matches a span that appends only trailing tokens after the injected line (echo artifacts)', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    const matches = matchBootstrapCommands(pending, [span('s1', 'agent-loop pickup 176 # echo', 0)], new Set());
    expect(matches.map((m) => m.spanId)).toEqual(['s1']);
  });

  it('does not match an unrelated command', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    expect(matchBootstrapCommands(pending, [span('s1', 'ls -la', 0)], new Set())).toEqual([]);
  });

  it('matches each pending bootstrap to at most one span (no double counting)', () => {
    const pending: PendingBootstrap[] = [{ repoKey: '/r', cmd: 'agent-loop pickup 176' }];
    const matches = matchBootstrapCommands(
      pending,
      [span('s1', 'agent-loop pickup 176', 0), span('s2', 'agent-loop pickup 176', 0)],
      new Set(),
    );
    expect(matches).toHaveLength(1);
  });
});
