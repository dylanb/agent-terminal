import { describe, expect, it } from 'vitest';
import { executeGateOutcome, type GateExecDeps } from '../../src/main/gateExecutor';
import type { GateOutcome } from '../../src/main/gateActions';
import type { LoopStateWrite } from '../../src/main/loopStateWriter';

// §26.6 / L5 — the imperative side of the gate transition: given a decided GateOutcome, it writes the
// state.yaml transition, runs the gh side-effects out of band (best-effort), appends the human note, and
// re-iterates (request-changes) or stops (terminal). Tested through injected domain ports — the writes,
// the gh op, and the re-iterate are the observable contract.

function harness(overrides: Partial<GateExecDeps> = {}) {
  const writes: LoopStateWrite[] = [];
  const notes: Array<{ iteration: number; text: string }> = [];
  const readyCalls: number[] = [];
  const reiterations: number[] = [];
  const subIssues: Array<{ title: string; body: string }> = [];
  const writeFailures: string[] = [];
  const execArgs: string[][] = [];
  let nextIssue = 100;
  const deps: GateExecDeps = {
    github: {
      markPrReady: async (pr) => void readyCalls.push(pr),
      createSubIssue: async (args) => {
        subIssues.push(args);
        return (nextIssue += 1);
      },
    },
    writeState: (s) => void writes.push(s),
    writeHumanNote: (iteration, text) => void notes.push({ iteration, text }),
    reiterate: (nextIteration) => void reiterations.push(nextIteration),
    // §26.9 — not an epic by default, so the L5 tests below observe the pre-L8 behavior unchanged.
    readEpicPlan: () => ({ isEpic: false, subTickets: [] }),
    onWriteFailed: (reason) => void writeFailures.push(reason),
    // §26.6 — exec ports: resolveArtifact maps the def's `{{artifact.<id>}}`; runExec records the argv.
    resolveArtifact: (id) => (id === 'ticket-body' ? '/repo/.agent-loop/ticket.md' : null),
    runExec: async (argv) => void execArgs.push(argv),
    ...overrides,
  };
  return { deps, writes, notes, readyCalls, reiterations, subIssues, writeFailures, execArgs };
}

const CTX = {
  repoDir: '/repo',
  boundLoop: 'plan-loop',
  iteration: 2,
  pr: 42,
  branch: 'plan-loop/issue-1',
  linkedIssues: [1],
  note: 'make it smaller',
  epicAlreadyPromoted: false,
  execAllowed: true,
};

const EXEC_ARGV = ['gh', 'issue', 'edit', '{{state.linked_issues[0]}}', '--body-file', '{{artifact.ticket-body}}'];
const execApproveOutcome: GateOutcome = {
  nextStatus: 'plan-human-approved',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'mark-pr-ready' }, { kind: 'exec', argv: EXEC_ARGV }, { kind: 'terminate' }],
};

const approveOutcome: GateOutcome = {
  nextStatus: 'plan-human-approved',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'mark-pr-ready' }, { kind: 'terminate' }],
};
// §26.9 / L8 — the real plan-approve action list leads with epic-promote (guarded at exec time on the
// plan's classification, so the effect is always present; the executor evaluates the epic plan).
const epicApproveOutcome: GateOutcome = {
  nextStatus: 'plan-human-approved',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'epic-promote' }, { kind: 'mark-pr-ready' }, { kind: 'terminate' }],
};
const requestChangesOutcome: GateOutcome = {
  nextStatus: 'plan-draft',
  terminate: false,
  reiterate: true,
  effects: [{ kind: 'reset-cap' }, { kind: 'clear-persona-state' }, { kind: 'append-human-note' }],
};
const impasseOutcome: GateOutcome = {
  nextStatus: 'impasse',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'append-human-note' }],
};

describe('executeGateOutcome (§26.6 / L5)', () => {
  it('approve: marks the PR ready, writes the terminal status + terminated, does not re-iterate', async () => {
    const h = harness();
    await executeGateOutcome(approveOutcome, CTX, h.deps);
    expect(h.readyCalls).toEqual([42]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved', iteration: 2, terminated: true });
    expect(h.reiterations).toEqual([]);
  });

  it('request-changes: resets the cap window at the critiqued iteration, clears persona_state, writes the human note, re-iterates at +1', async () => {
    const h = harness();
    await executeGateOutcome(requestChangesOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({
      status: 'plan-draft',
      iteration: 3,
      capBaseline: 2,
      clearPersonaState: true,
    });
    expect(h.notes).toEqual([{ iteration: 2, text: 'make it smaller' }]);
    expect(h.reiterations).toEqual([3]);
    expect(h.readyCalls).toEqual([]); // no gh side-effect for request-changes
  });

  it('impasse: writes the human note + terminal impasse status, no gh, no re-iterate', async () => {
    const h = harness();
    await executeGateOutcome(impasseOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({ status: 'impasse', terminated: true });
    expect(h.notes).toHaveLength(1);
    expect(h.readyCalls).toEqual([]);
    expect(h.reiterations).toEqual([]);
  });

  it('a gh side-effect failure does not abort the transition (best-effort, §26.11)', async () => {
    const h = harness({
      github: { markPrReady: async () => { throw new Error('gh offline'); }, createSubIssue: async () => null },
    });
    await executeGateOutcome(approveOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved', terminated: true });
  });

  it('a state-write failure surfaces the reason and does not re-iterate (never silently strands the loop, §26.6/D48)', async () => {
    const h = harness({
      writeState: () => {
        throw new Error('disk full');
      },
    });
    // A rejected promise here would surface as an unhandled rejection in main (the void call site cannot see
    // it), so the executor must still resolve and must NOT re-iterate against unpersisted state. But the
    // failure must no longer be SILENT: the loop would otherwise sit stranded with no error and no trace, so
    // the executor reports it through onWriteFailed for the host to surface (error dialog + audit).
    await expect(executeGateOutcome(requestChangesOutcome, CTX, h.deps)).resolves.toBeUndefined();
    expect(h.reiterations).toEqual([]);
    expect(h.writeFailures).toHaveLength(1);
    expect(h.writeFailures[0]).toContain('disk full');
  });

  it('surfaces a non-Error write failure as a non-empty reason (never a bare "undefined", §26.6/D48)', async () => {
    const h = harness({
      writeState: () => {
        // A throw that is not an Error instance — `(e as Error).message` would be undefined.
        throw 'ENOSPC: no space left on device';
      },
    });
    await expect(executeGateOutcome(requestChangesOutcome, CTX, h.deps)).resolves.toBeUndefined();
    expect(h.writeFailures).toHaveLength(1);
    expect(h.writeFailures[0]).toContain('ENOSPC');
  });

  it('does not mark a PR ready when there is no PR number', async () => {
    const h = harness();
    await executeGateOutcome(approveOutcome, { ...CTX, pr: null }, h.deps);
    expect(h.readyCalls).toEqual([]);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved' });
  });

  // §26.9 / L8 — epic-promote reuses the current PR for sub-ticket-1 and creates the remaining N-1
  // sub-issues out of band, appending them to linked_issues + recording `epic` in state.yaml.
  it('epic approve: creates N-1 sub-issues (sub-ticket-1 is the current PR), appends linked_issues + records epic', async () => {
    const h = harness({
      readEpicPlan: () => ({
        isEpic: true,
        subTickets: [
          { title: 'Slice 1', body: 'reuses this PR' },
          { title: 'Slice 2', body: 'second' },
          { title: 'Slice 3', body: 'third' },
        ],
      }),
    });
    await executeGateOutcome(epicApproveOutcome, CTX, h.deps);
    // Only the N-1 remaining sub-tickets are created (the first reuses the current PR).
    expect(h.subIssues).toEqual([
      { title: 'Slice 2', body: 'second' },
      { title: 'Slice 3', body: 'third' },
    ]);
    // The created issue numbers are appended to linked_issues and recorded under `epic`.
    expect(h.writes[0]).toMatchObject({
      status: 'plan-human-approved',
      terminated: true,
      linkedIssues: [1, 101, 102],
      epic: { subIssues: [101, 102] },
    });
    expect(h.readyCalls).toEqual([42]); // still marks the PR ready
  });

  it('non-epic approve: no sub-issues, no epic field, linked_issues unchanged', async () => {
    const h = harness(); // readEpicPlan defaults to not-an-epic
    await executeGateOutcome(epicApproveOutcome, CTX, h.deps);
    expect(h.subIssues).toEqual([]);
    expect(h.writes[0].epic).toBeUndefined();
    expect(h.writes[0].linkedIssues).toEqual([1]);
  });

  it('a single-sub-ticket epic creates zero sub-issues (the current PR is sub-ticket-1)', async () => {
    const h = harness({ readEpicPlan: () => ({ isEpic: true, subTickets: [{ title: 'only', body: '' }] }) });
    await executeGateOutcome(epicApproveOutcome, CTX, h.deps);
    expect(h.subIssues).toEqual([]);
    expect(h.writes[0].linkedIssues).toEqual([1]);
  });

  it('a sub-issue creation failure is best-effort: it is skipped, the transition still writes', async () => {
    let n = 0;
    const h = harness({
      github: {
        markPrReady: async () => {},
        // First sub-issue create fails (null), second throws, third succeeds — only the survivor lands.
        createSubIssue: async () => {
          n += 1;
          if (n === 1) return null;
          if (n === 2) throw new Error('gh offline');
          return 303;
        },
      },
      readEpicPlan: () => ({
        isEpic: true,
        subTickets: [
          { title: 'reuse', body: '' },
          { title: 'a', body: '' },
          { title: 'b', body: '' },
          { title: 'c', body: '' },
        ],
      }),
    });
    await executeGateOutcome(epicApproveOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({
      status: 'plan-human-approved',
      terminated: true,
      linkedIssues: [1, 303],
      epic: { subIssues: [303] },
    });
  });

  // §26.9 — epic-promote is an irreversible external write (gh issue create). A gate re-entered after the
  // epic was already promoted (operator rewinds + re-approves) must NOT create a duplicate set of issues.
  it('epic-promote is idempotent: creates no sub-issues when the epic was already promoted', async () => {
    const h = harness({
      readEpicPlan: () => ({
        isEpic: true,
        subTickets: [
          { title: 'Slice 1', body: '' },
          { title: 'Slice 2', body: '' },
          { title: 'Slice 3', body: '' },
        ],
      }),
    });
    await executeGateOutcome(epicApproveOutcome, { ...CTX, epicAlreadyPromoted: true }, h.deps);
    expect(h.subIssues).toEqual([]); // no duplicate gh issue create
    expect(h.writes[0].epic).toBeUndefined();
    expect(h.writes[0].linkedIssues).toEqual([1]); // linked_issues not re-appended
    expect(h.readyCalls).toEqual([42]); // the other effects still run
  });

  // §26.6 — the exec gate action (ticket-body publish). Runs out of band, best-effort, only when the repo
  // has not opted the loop out (execAllowed) and its argv fully resolves.
  it('exec: interpolates the argv and runs it when execAllowed', async () => {
    const h = harness();
    await executeGateOutcome(execApproveOutcome, CTX, h.deps);
    expect(h.execArgs).toEqual([['gh', 'issue', 'edit', '1', '--body-file', '/repo/.agent-loop/ticket.md']]);
    expect(h.writes[0].status).toBe('plan-human-approved'); // the transition still lands
  });

  it('exec: does NOT run when the loop is opted out (execAllowed false)', async () => {
    const h = harness();
    await executeGateOutcome(execApproveOutcome, { ...CTX, execAllowed: false }, h.deps);
    expect(h.execArgs).toEqual([]);
    expect(h.writes[0].status).toBe('plan-human-approved'); // other effects + transition unaffected
  });

  it('exec: does NOT run when the argv cannot be fully resolved (no linked issue)', async () => {
    const h = harness();
    await executeGateOutcome(execApproveOutcome, { ...CTX, linkedIssues: [] }, h.deps);
    expect(h.execArgs).toEqual([]); // never a half-filled gh command
    expect(h.writes[0].status).toBe('plan-human-approved');
  });

  it('exec: a failing exec is swallowed (best-effort §26.11) — the state write still lands', async () => {
    const h = harness({
      runExec: async () => {
        throw new Error('gh not found');
      },
    });
    await executeGateOutcome(execApproveOutcome, CTX, h.deps);
    expect(h.writes[0].status).toBe('plan-human-approved');
    expect(h.writeFailures).toEqual([]); // an exec failure is NOT a gate-write failure
  });
});
