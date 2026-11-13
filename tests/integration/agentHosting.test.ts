import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentHosting, type AgentHosting } from '../../src/main/agentHosting';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { readAuditRun } from '../../src/main/auditRun';
import type { AgentKind } from '../../src/shared/agentKind';
import type { FlowLike } from '../../src/shared/audit';
import { logsTempDir } from '../helpers/agentUsageLogs';

// The agents that ran in a run (Scope 9): sampled from the terminal, recorded in the run's real §25 record by the
// real recorder, and read back from that record.

const FLOW = 'hosting-flow';
const T0 = Date.parse('2026-06-26T09:00:00.318Z');
const IN = (stepName: string): FlowLike => ({ status: 'in_progress', stepName });
const DONE = (stepName: string): FlowLike => ({ status: 'done', stepName });

function hostingRig() {
  const { dir } = logsTempDir('agent-hosting-', onTestFinished);
  const worktree = join(dir, 'repo');
  const other = join(dir, 'other');
  const auditRoot = join(dir, 'audit');
  mkdirSync(worktree);
  mkdirSync(other);
  let clock = T0;
  const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date(clock), flowName: () => FLOW });
  const terminal: { repo: string | null; agent: AgentKind | null } = { repo: worktree, agent: null };
  const logged: unknown[] = [];
  const record = () => readAuditRun(auditRoot, { repoPath: worktree, flow: FLOW, started: new Date(T0) });
  return {
    other,
    terminal,
    logged,
    /** A sampler as the app builds one at launch. */
    sampler: (
      currentRun = (repoKey: string) => readAuditRun(auditRoot, { repoPath: repoKey, flow: FLOW, started: new Date(T0) }),
      hostedAgent = (): AgentKind | null => terminal.agent,
    ): AgentHosting =>
      createAgentHosting({
        terminalRepo: () => terminal.repo,
        currentRun,
        hostedAgent,
        record: (repoKey, agent) => recorder.recordHostedAgent(repoKey, agent),
        log: (_message, error) => void logged.push(error),
      }),
    start(): void {
      recorder.recordTransition(worktree, 'start', { status: 'not_started', stepName: 'one' }, IN('one'), { startedAt: T0, flow: FLOW });
    },
    move(before: FlowLike, after: FlowLike, at: number): void {
      clock = at;
      recorder.recordTransition(worktree, 'advance', before, after);
    },
    agents: (): AgentKind[] => record().agents,
    entries: (): number => record().events.filter((e) => e.type === 'agent.hosted').length,
  };
}

describe('the agents that ran in a run', () => {
  it('records each agent the terminal hosts while a step window is open, once per run, in the order it first hosted them', () => {
    const r = hostingRig();
    const hosting = r.sampler();
    r.start();
    r.terminal.agent = 'codex';
    hosting.sample();
    hosting.sample();
    r.move(IN('one'), IN('two'), T0 + 5_000);
    r.terminal.agent = 'claude-code';
    hosting.sample();
    r.terminal.agent = 'codex';
    hosting.sample();

    expect({ agents: r.agents(), entries: r.entries() }).toEqual({ agents: ['codex', 'claude-code'], entries: 2 });
  });

  it('stops asking which agent the terminal hosts once the run has recorded every agent', () => {
    const r = hostingRig();
    let asked = 0;
    const hosting = r.sampler(undefined, () => {
      asked++;
      return r.terminal.agent;
    });
    r.start();
    r.terminal.agent = 'codex';
    hosting.sample();
    r.terminal.agent = 'claude-code';
    hosting.sample();
    hosting.sample();
    hosting.sample();

    expect({ agents: r.agents(), asked }).toEqual({ agents: ['codex', 'claude-code'], asked: 2 });
  });

  it('records nothing once the flow is complete, when no step window is open', () => {
    const r = hostingRig();
    const hosting = r.sampler();
    r.start();
    r.move(IN('one'), DONE('one'), T0 + 5_000);
    r.terminal.agent = 'claude-code';
    hosting.sample();

    expect(r.agents()).toEqual([]);
  });

  it('records nothing while the terminal hosts no agent it can name, or sits in another worktree', () => {
    const r = hostingRig();
    const hosting = r.sampler();
    r.start();
    hosting.sample();
    r.terminal.repo = r.other;
    r.terminal.agent = 'codex';
    hosting.sample();

    expect(r.agents()).toEqual([]);
  });

  it('after a relaunch, a fresh sampler rebuilds the set from the record and records no agent twice', () => {
    const r = hostingRig();
    r.start();
    r.terminal.agent = 'claude-code';
    r.sampler().sample();

    const relaunched = r.sampler();
    relaunched.sample();
    r.terminal.agent = 'codex';
    relaunched.sample();

    expect({ agents: r.agents(), entries: r.entries() }).toEqual({ agents: ['claude-code', 'codex'], entries: 2 });
  });

  it('a sample whose record cannot be read never throws, records nothing and logs why', () => {
    const r = hostingRig();
    r.start();
    r.terminal.agent = 'codex';
    const hosting = r.sampler(() => {
      throw new Error('the record moved');
    });

    expect(() => hosting.sample()).not.toThrow();
    expect({ agents: r.agents(), logged: r.logged.length }).toEqual({ agents: [], logged: 1 });
  });
});
