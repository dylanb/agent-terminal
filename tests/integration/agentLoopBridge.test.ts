import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('decodes the writer\'s pr:0 sentinel back to null (lossless null round-trip, §26.6)', () => {
    // loopStateWriter serializes a null PR as the whole-document-valid `0`; the mirror must decode `0`
    // back to null (GitHub PR numbers are >=1), or a null-PR state surfaces a bogus reference to "PR #0".
    writeState('schema_version: 4\nstatus: planning\niteration: 1\npr: 0\n');
    expect(parseAgentLoopState(dir)?.pr).toBeNull();
  });

  it('mirrors several linked issues, dropping non-numeric entries (degrading parser)', () => {
    writeState('schema_version: 4\niteration: 2\nstatus: planning\nlinked_issues:\n    - 25\n    - 26\n    - oops\n');
    expect(parseAgentLoopState(dir)?.linkedIssues).toEqual([25, 26]);
  });

  // A linked issue reaches `gh issue edit <n>` as an argv element (§26.6 exec). A negative or fractional
  // "number" is still a number, and `-1` arrives where gh expects an operand — it reads as an option
  // (CWE-88). GitHub issue numbers are positive integers; nothing else is one.
  it('drops linked_issues entries that are not positive integers (CWE-88 argument injection)', () => {
    writeState('schema_version: 4\niteration: 2\nstatus: planning\nlinked_issues:\n    - -1\n    - 0\n    - 1.5\n    - 26\n');
    expect(parseAgentLoopState(dir)?.linkedIssues).toEqual([26]);
  });

  // Both contract surfaces (AgentLoopState.errorReason, FlowLoopView.errorReason) say "present only at
  // status: error". Only the app's own writer deletes the key on a non-error write — a hand-edited file, a
  // rebind doc, or any other writer §26.6 contemplates would leave it, and the panel would render it.
  it('surfaces error_reason only at status: error (the field is conditional on both contract surfaces)', () => {
    writeState('schema_version: 4\niteration: 2\nstatus: error\nerror_reason: the turn stalled\n');
    expect(parseAgentLoopState(dir)?.errorReason).toBe('the turn stalled');

    writeState('schema_version: 4\niteration: 2\nstatus: planning\nerror_reason: stale leftover\n');
    expect(parseAgentLoopState(dir)?.errorReason).toBeUndefined();
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
    expect(stop).not.toBeNull();
    try {
      // fs.watch arms asynchronously (FSEvents on darwin), so a change written before it is armed is
      // dropped and never redelivered — a single write races the watcher and hangs to the cap. Re-write
      // on every poll: the happy path resolves on the first event, a dead watcher still fails at the cap.
      await vi.waitFor(() => {
        writeState('schema_version: 4\niteration: 10\nstatus: awaiting-team-review\n');
        expect(fired).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 50 });
    } finally {
      stop?.();
    }
  }, 15_000);

  // The caller (index.ts) caches one watcher per repo and never retries once an entry exists. If a
  // failed watch attempt (no .agent-loop dir yet — refs can show a ticket from a typed input before
  // `agent-loop pickup` creates the dir) were cached as a live entry, a state.yaml that appears later
  // would never push live. Signalling failure with null lets the caller skip caching and re-attach
  // on a later transition once the dir exists.
  it('returns null when the .agent-loop directory cannot be watched (does not exist yet)', () => {
    expect(watchAgentLoopState(dir, () => {})).toBeNull(); // beforeEach made `dir` but no .agent-loop
  });
});
