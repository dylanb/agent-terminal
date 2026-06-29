import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgentLoopState, watchAgentLoopState } from '../../src/main/agentLoopBridge';

// §24.2.3 T2 — the read-only agent-loop bridge parses real v4 <repo>/.agent-loop/state.yaml and
// NEVER throws: unknown schema_version / corrupt / missing all degrade to null (mirrors the §19.1
// store). A directory watcher fires on change so flow:onStateChanged can re-pull (§24.2.2 S5).
// Real temp files, no fs mocks.

const V4 =
  'schema_version: 4\n' +
  'pr: 179\n' +
  'branch: agent-loop/issue-176\n' +
  'iteration: 9\n' +
  'status: awaiting-human-pr-approval\n' +
  'linked_issues:\n' +
  '    - 176\n';

describe('agent-loop state.yaml bridge (§24.2.3 T2 / §19.1)', () => {
  let dir: string;
  const loopDir = (): string => join(dir, '.agent-loop');
  const writeState = (yaml: string): void => {
    mkdirSync(loopDir(), { recursive: true });
    writeFileSync(join(loopDir(), 'state.yaml'), yaml);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-loop-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses a real v4 state.yaml into {status, iteration, pr, branch, linkedIssues}', () => {
    writeState(V4);
    const s = parseAgentLoopState(dir);
    expect(s).toEqual({
      status: 'awaiting-human-pr-approval',
      iteration: 9,
      pr: 179,
      branch: 'agent-loop/issue-176',
      linkedIssues: [176],
    });
  });

  it('mirrors a plan-phase loop with no PR yet (pr/branch absent → null, no linked issues → [])', () => {
    writeState('schema_version: 4\niteration: 1\nstatus: planning\n');
    expect(parseAgentLoopState(dir)).toEqual({ status: 'planning', iteration: 1, pr: null, branch: null, linkedIssues: [] });
  });

  it('mirrors several linked issues, dropping non-numeric entries (degrading parser)', () => {
    writeState('schema_version: 4\niteration: 2\nstatus: planning\nlinked_issues:\n    - 25\n    - 26\n    - oops\n');
    expect(parseAgentLoopState(dir)?.linkedIssues).toEqual([25, 26]);
  });

  it('returns null (never throws) for an unknown schema_version', () => {
    writeState('schema_version: 99\nstatus: x\niteration: 1\n');
    expect(parseAgentLoopState(dir)).toBeNull();
  });

  it('accepts schema_version 4 in either YAML scalar form (bare number or quoted string)', () => {
    // state.yaml writes a bare number, LoopDefs a quoted "4"; one value-comparing guard must accept both.
    writeState('schema_version: "4"\nstatus: planning\niteration: 1\n');
    expect(parseAgentLoopState(dir)).toEqual({ status: 'planning', iteration: 1, pr: null, branch: null, linkedIssues: [] });
  });

  it('returns null (never throws) for corrupt YAML', () => {
    writeState('schema_version: 4\n  status: : : broken\n\t- nope');
    expect(parseAgentLoopState(dir)).toBeNull();
  });

  it('returns null when state.yaml is absent', () => {
    expect(parseAgentLoopState(dir)).toBeNull();
  });

  it('returns null when status or iteration are missing/ill-typed', () => {
    writeState('schema_version: 4\npr: 1\n'); // no status, no iteration
    expect(parseAgentLoopState(dir)).toBeNull();
  });

  it('fires the watch callback when state.yaml changes', async () => {
    writeState(V4);
    let fired = 0;
    const stop = watchAgentLoopState(dir, () => {
      fired += 1;
    });
    try {
      writeState('schema_version: 4\niteration: 10\nstatus: awaiting-team-review\n');
      await new Promise<void>((resolve, reject) => {
        const t0 = Date.now();
        const poll = (): void => {
          if (fired > 0) return resolve();
          if (Date.now() - t0 > 2000) return reject(new Error('watch did not fire within 2s'));
          setTimeout(poll, 20);
        };
        poll();
      });
      expect(fired).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
