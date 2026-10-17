import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentKind } from '../../src/main/agentKind';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { createAppLoopEngineHarness } from '../helpers/appLoopEngineHarness';

// §27.4 (v2.201) — the engine names each reviewer the way the hosted agent installs it: a Claude Code
// sub-agent by its subagent_type, a Codex custom agent by its Codex name.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, fileDef, enterAndInjectWork, driveToReviewInjected } = h;

const goalDef = (): LoopDefV2 => {
  const base = fileDef();
  return { ...base, work: { ...base.work, goal: 'the latest review pass returned no findings' }, rounds: { kind: 'none' } };
};
const engineFor = (kind: AgentKind, problem: (agent: string) => string | null = () => null) =>
  makeEngine(undefined, undefined, undefined, {
    hostedAgentKind: () => kind,
    reviewerAgentProblem: (r, k) => (k === kind ? problem(r.persona) : `asked about ${k}, not ${kind}`),
  });
const goalPrompt = (): string => {
  const cmd = h.injected.find((p) => p.startsWith('/goal '));
  const rel = cmd === undefined ? undefined : /\.agent-terminal\/\S+\.md/.exec(cmd)?.[0];
  if (rel === undefined) throw new Error(`no /goal prompt was injected: ${JSON.stringify(h.injected)}`);
  return readFileSync(join(h.repo, rel), 'utf8');
};
const reviewPrompt = (): string => {
  const p = h.injected.find((t) => t.startsWith('This is the review-and-fix turn'));
  if (p === undefined) throw new Error(`no review prompt was injected: ${JSON.stringify(h.injected)}`);
  return p;
};

beforeEach(h.setUp);
afterEach(h.tearDown);

describe('under Codex the turns name each reviewer as its Codex agent (§27.4 v2.201)', () => {
  it('a review-and-fix round spawns the Codex agents by name, never a Claude Code subagent_type', () => {
    const engine = engineFor('codex');
    driveToReviewInjected(engine);

    const prompt = reviewPrompt();
    expect(prompt).toContain('plan_loop__review_plan_principal');
    expect(prompt).toContain('plan_loop__review_plan_security');
    expect(prompt).not.toContain('subagent_type');
    expect(prompt).not.toContain('Task tool');
  });

  it('a goal session spawns the Codex agents by name', () => {
    const engine = engineFor('codex');
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    const prompt = goalPrompt();
    expect(prompt).toContain('plan_loop__review_plan_principal');
    expect(prompt).not.toContain('subagent_type');
  });

  it('under Claude Code the same round still spawns sub-agents by subagent_type', () => {
    const engine = engineFor('claude-code');
    driveToReviewInjected(engine);

    expect(reviewPrompt()).toContain('subagent_type: plan-loop--review-plan-principal');
  });

  it('names the reviewers for the same agent it checked them against, within one turn', () => {
    const kinds: AgentKind[] = ['claude-code', 'codex', 'codex', 'codex'];
    const engine = makeEngine(undefined, undefined, undefined, {
      hostedAgentKind: () => kinds.shift() ?? 'codex',
      reviewerAgentProblem: (r, k) => (k === 'codex' ? `no Codex agent for ${r.persona} is installed` : null),
    });
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(goalPrompt()).toContain('subagent_type');
  });

  it('a turn with no reviewers never asks which agent is hosted', () => {
    let asked = 0;
    const engine = makeEngine(undefined, undefined, undefined, {
      hostedAgentKind: () => {
        asked += 1;
        return 'claude-code';
      },
    });
    h.defResult = resolved({ ...fileDef(), reviewers: [], rounds: { kind: 'none' } });
    enterAndInjectWork(engine);

    expect(h.injected.some((p) => p.includes('turn-done:'))).toBe(true);
    expect(asked).toBe(0);
  });

  it('with no agent at the prompt it says so, not that reviewers are missing', () => {
    const engine = makeEngine(undefined, undefined, undefined, {
      hostedAgent: () => 'absent',
      reviewerAgentProblem: (r) => `no sub-agent ${r.persona} is installed`,
    });
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(engine.liveErrorFor(h.repo)?.reason).toBe('no hosted agent at the prompt');
  });

  it('refuses the turn when the Codex agent of a reviewer is not installed, and says how to install it', () => {
    const engine = engineFor('codex', (persona) => (persona === 'review-plan-security' ? 'no Codex agent plan_loop__review_plan_security is installed' : null));
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(h.injected.some((p) => p.startsWith('/goal '))).toBe(false);
    const reason = engine.liveErrorFor(h.repo)?.reason ?? '';
    expect(reason).toContain('no Codex agent plan_loop__review_plan_security is installed');
    expect(reason).toContain('Codex');
    expect(reason).not.toContain('Claude Code sub-agents');
  });
});
