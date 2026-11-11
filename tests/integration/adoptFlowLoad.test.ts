import { FLOW_DEF_FILE } from '../../src/main/flowHome';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { createRunResolver } from '../../src/main/runResolver';
import { flowHomeDir, type FlowLoad } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { repoOnlyDefTiers } from '../helpers/defTiers';

// #304 AC 25 — a flow that adopts a pull request fails to load when another of its steps, inputs or gates could
// act on a ticket run's pickup, its PR body or its draft state, or let the flow's PR differ from the adopted one.
// Driven through the one flow load every view shares, over real flow and loop-def files in the repository tier.

type Gate = Array<{ option: string; side_effects?: Array<Record<string, string>> }>;
type Step = Record<string, unknown>;

interface Fixture {
  adoptStep?: Partial<Step>;
  otherStep?: Partial<Step>;
  adoptGate?: Gate;
  otherGate?: Gate;
  otherPickup?: Record<string, string>;
  withAdoptStep?: boolean;
}

const PR_INPUT = { name: 'reviewed', type: 'pr', required: true };
const TICKET_PICKUP = { initial_status: 'planning', branch_template: 'plan-loop/issue-{issue}' };
const approveWith = (...sideEffects: Array<Record<string, string>>): Gate => [{ option: 'approve', side_effects: sideEffects }];

const fx = createWorktreeFixture();
afterEach(() => fx.cleanup());

function writeDef(wt: string, name: string, def: Record<string, unknown>): string {
  const dir = join(wt, 'loops', name);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'work.md'), 'work\n');
  writeFileSync(join(dir, `${name}.yaml`), dump({
    version: 'v2',
    work: { recipe: 'prompts/work.md', artifact: 'report' },
    reviewers: [],
    boundaries: [],
    report: { sections: ['summary'] },
    outputs: [{ id: 'report', path: `${name}-report.md` }],
    ...def,
  }));
  return `loops/${name}/${name}.yaml`;
}

function load(f: Fixture): FlowLoad {
  const wt = fx.makeWorktree('adopt-load-wt');
  const home = fx.makeWorktree('adopt-load-home');
  const loops = {
    'review-loop': writeDef(wt, 'review-loop', {
      pickup: { adopt: 'pr' },
      gate: f.adoptGate ?? approveWith({ kind: 'gh', action: 'publish-pr-review', artifact: 'report' }),
    }),
    'other-loop': writeDef(wt, 'other-loop', {
      gate: f.otherGate ?? [{ option: 'approve' }],
      ...(f.otherPickup === undefined ? {} : { pickup: f.otherPickup }),
    }),
  };
  writeFileSync(join(wt, '.agent-loop.yaml'), dump({ loops }));
  const steps: Step[] = [
    { id: 'prep', kind: 'manual' },
    ...(f.withAdoptStep === false ? [] : [{ id: 'adopt-step', kind: 'loop', loop: 'review-loop', bootstrap: 'pickup', inputs: [PR_INPUT], ...f.adoptStep }]),
    { id: 'other-step', kind: 'loop', loop: 'other-loop', ...f.otherStep },
  ];
  writeFileSync(join(flowHomeDir(wt), FLOW_DEF_FILE), dump({ name: 'adopt-load', steps }));
  return createRunResolver(home, repoOnlyDefTiers())(wt).load;
}

const loadError = (f: Fixture): string => {
  const result = load(f);
  return result.ok ? 'the flow loaded' : result.error;
};

describe('a flow that adopts a pull request loads only when nothing else in it can act as a ticket run (#304 AC 25)', () => {
  it('loads with one required pr input on the adopting step and its publish declared on its own gate', () => {
    expect(loadError({})).toBe('the flow loaded');
  });

  it('a flow with no adopting step keeps every ticket-run pickup and gate effect it declares (AC 26)', () => {
    expect(
      loadError({
        withAdoptStep: false,
        otherStep: { bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }, { name: 'pr', type: 'pr' }] },
        otherPickup: TICKET_PICKUP,
        otherGate: approveWith({ kind: 'gh', action: 'mark-ready' }, { kind: 'gh', action: 'publish-pr-body', artifact: 'report' }),
      }),
    ).toBe('the flow loaded');
  });

  it.each([
    ['has no pr-typed input', [{ name: 'reviewed', type: 'github-ticket', required: true }]],
    ['has a pr-typed input that is not required', [{ name: 'reviewed', type: 'pr' }]],
  ])('fails when the adopting step %s, naming the step and the pr input', (_case, inputs) => {
    const error = loadError({ adoptStep: { inputs } });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toMatch(/\bpr\b/i);
  });

  it('fails when another step declares a pr-typed input, naming both steps', () => {
    const error = loadError({ otherStep: { inputs: [{ name: 'second', type: 'pr' }] } });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
  });

  it('fails when the adopting step declares a second pr-typed input, naming the step and that input', () => {
    const error = loadError({ adoptStep: { inputs: [PR_INPUT, { name: 'second', type: 'pr' }] } });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('second');
  });

  it('fails when another step picks up a ticket, naming both steps', () => {
    const error = loadError({ otherStep: { bootstrap: 'pickup' }, otherPickup: TICKET_PICKUP });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
  });

  it.each([
    ['update-issue-body', { kind: 'gh', action: 'update-issue-body', artifact: 'report' }],
    ['mark-ready', { kind: 'gh', action: 'mark-ready' }],
    ['publish-pr-body', { kind: 'gh', action: 'publish-pr-body', artifact: 'report' }],
    ['promote', { kind: 'promote', artifact: 'report' }],
  ])("fails when another step's gate declares %s, naming the adopting step, that step and the effect", (effect, sideEffect) => {
    const error = loadError({ otherGate: approveWith(sideEffect) });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
    expect.soft(error).toContain(effect);
  });

  it("fails when the adopting step's own gate declares mark-ready, naming the step and the effect", () => {
    const error = loadError({ adoptGate: approveWith({ kind: 'gh', action: 'publish-pr-review', artifact: 'report' }, { kind: 'gh', action: 'mark-ready' }) });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('mark-ready');
  });

  it('fails when the adopting step declares gate_authority: auto, naming the step and the authority', () => {
    const error = loadError({ adoptStep: { gate_authority: 'auto' } });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toMatch(/gate_authority|auto/);
  });

  it("fails when publish-pr-review is declared on another step's gate, naming both steps and the effect", () => {
    const error = loadError({ otherGate: approveWith({ kind: 'gh', action: 'publish-pr-review', artifact: 'report' }) });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
    expect.soft(error).toContain('publish-pr-review');
  });

  it("fails when publish-pr-review's artifact is not one of the adopting step's outputs, naming the step and the artifact", () => {
    const error = loadError({ adoptGate: approveWith({ kind: 'gh', action: 'publish-pr-review', artifact: 'not-an-output' }) });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('not-an-output');
  });

  it('fails when a second step also adopts a pull request, naming both steps', () => {
    const error = loadError({ otherPickup: { adopt: 'pr' } });
    expect.soft(error).toContain('adopt-step');
    expect.soft(error).toContain('other-step');
  });
});
