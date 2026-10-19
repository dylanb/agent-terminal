import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';
import { EPIC_GRAMMAR, epicPlanWellFormed, exampleEpicPlan } from '../../src/shared/epicPlan';
import { exampleSlicePlan, slicePlanWellFormed, SLICE_GRAMMAR } from '../../src/shared/slicePlan';

// feature-dev-v3 (v2.200, v2.201) — feature-dev-v2 with grooming split into three steps: an interview that settles
// the intent and what may be decided without the operator, a goal session that grooms and reviews until a review
// pass finds nothing, and a presentation the operator approves as is or fixes in that same session. Each
// implementation step is then a goal session that reviews its own work and logs its decisions, and one final
// step presents them all for the operator's approval. Planning (#212) is one goal session that drafts, polishes and
// reviews the plan, and a presentation the operator approves once.

const FLOWS = resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR });
const V2 = 'feature-dev-v2';
const V3 = 'feature-dev-v3';
const GROOM_STEPS = ['groom-intent', 'groom', 'groom-approve'];
const V2_PLAN_STEPS = ['plan-bundle', 'plan-polish'];
const PLAN_STEPS = ['plan', 'plan-approve'];
const V3_STEPS = [...GROOM_STEPS, ...PLAN_STEPS, 'impl-approve'];
const CODE_LOOPS = ['infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'];

function loopV2(name: string): LoopDefV2 {
  const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow: V2 });
  if (!r.ok) throw new Error(r.reason);
  return r.def;
}

function flow(id: string) {
  const r = loadUntrustedFlowDefinition(join(FLOWS, id, 'flow.yaml'));
  if (!r.ok) throw new Error(r.error);
  return r.definition;
}

function loop(name: string): LoopDefV2 {
  const r = resolveLoopDefV2(name, { tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null }, repoDir: REPO_DIR, flow: V3 });
  if (!r.ok) throw new Error(r.reason);
  return r.def;
}

const text = (path: string): string => readFileSync(path, 'utf8');
const brief = (def: LoopDefV2): string => (def.brief === undefined ? '' : text(def.brief));
const prompt = (def: LoopDefV2): string => `${brief(def)}\n${text(def.work.recipe)}`;

describe('feature-dev-v3 grooms in three steps, and approves the implementation once at the end', () => {
  it('replaces v2\'s groom step with the three, its two planning steps with two, adds the implementation approval before finalize, and keeps v2\'s other steps', () => {
    const v2 = flow(V2).steps;
    const v3 = flow(V3).steps;
    const expected = v2.flatMap((s) => (s.id === 'groom' ? GROOM_STEPS : s.id === 'plan-bundle' ? PLAN_STEPS : s.id === 'plan-polish' ? [] : [s.id]));
    expected.splice(expected.indexOf('finalize'), 0, 'impl-approve');
    expect(v3.map((s) => s.id)).toEqual(expected);
    const asV2 = (s: (typeof v3)[number]) => (s.id === 'integration-slice' ? { ...s, gateAuthority: 'human' } : s);
    expect(v3.filter((s) => !V3_STEPS.includes(s.id)).map(asV2)).toEqual(v2.filter((s) => s.id !== 'groom' && !V2_PLAN_STEPS.includes(s.id)));
  });

  it('leaves the operator only the groom approval, the plan approval and the implementation approval', () => {
    const humans = flow(V3).steps.filter((s) => s.kind === 'loop' && s.gateAuthority !== 'auto').map((s) => s.id);
    expect(humans).toEqual(['groom-approve', 'plan-approve', 'impl-approve']);
  });

  it('asks for the ticket at the interview, and leaves only the approval to a human', () => {
    const steps = flow(V3).steps;
    const byId = (id: string) => steps.find((s) => s.id === id)!;
    expect(byId('groom-intent').inputs?.map((i) => i.name)).toEqual(['ticket']);
    expect(byId('groom-intent').gateAuthority).toBe('auto');
    expect(byId('groom').gateAuthority).toBe('auto');
    expect(byId('groom-approve').gateAuthority).toBe('human');
  });

  it('ships no copy of v2\'s planning loops, which no v3 step runs', () => {
    const v3Loops = readdirSync(join(BUNDLED_LOOPS_ROOT, V3));
    expect(v3Loops).not.toContain('plan-bundle-loop');
    expect(v3Loops).not.toContain('plan-polish-loop');
    const run = flow(V3).steps.flatMap((s) => (s.kind === 'loop' ? [s.loop] : []));
    expect([...v3Loops].sort()).toEqual([...new Set(run)].sort());
  });
});

describe('the three groom loops', () => {
  it('the interview runs no review rounds and writes the intent the next step reads', () => {
    const intent = loop('groom-intent-loop');
    expect(intent.rounds).toEqual({ kind: 'none' });
    expect(intent.reviewers).toEqual([]);
    expect(intent.outputs.map((o) => o.id)).toContain('groom-intent');
    expect(loop('groom-goal-loop').inputs.map((i) => i.id)).toContain('groom-intent');
  });

  it('the groom step is a goal session that runs the intent reviewer itself', () => {
    const goal = loop('groom-goal-loop');
    expect(goal.work.goal).toMatch(/no findings/);
    expect(goal.reviewers.map((r) => r.persona)).toEqual(['review-plan-intent']);
    expect(goal.rounds).toEqual({ kind: 'none' });
    expect(goal.outputs.map((o) => o.id).sort()).toEqual(['groom-report', 'groomed-ticket']);
  });

  it('the approval step presents both and publishes the groomed ticket to the issue on approve', () => {
    const approve = loop('groom-approve-loop');
    expect(approve.rounds).toEqual({ kind: 'none' });
    expect(approve.inputs.map((i) => i.id).sort()).toEqual(['groom-intent', 'groom-report', 'groomed-ticket']);
    const onApprove = approve.gate.find((g) => g.option === 'approve')?.sideEffects ?? [];
    expect(onApprove).toEqual([{ kind: 'gh', args: { action: 'update-issue-body', artifact: 'groomed-ticket' } }]);
  });

  it('the groom step never stops to ask: it decides inside the boundary the interview set and logs every decision', () => {
    const groom = prompt(loop('groom-goal-loop'));
    expect(groom).toContain('## Decision boundary');
    expect(groom).toContain('## Groomer decisions');
    expect(groom).toContain('## Needs your call');
    expect(groom).not.toMatch(/interview the operator/i);
  });

  it('the approval step presents the same sections the groom step writes', () => {
    const present = prompt(loop('groom-approve-loop'));
    for (const heading of ['## Needs your call', '## Groomer decisions', '## Review history']) {
      expect(prompt(loop('groom-goal-loop'))).toContain(heading);
      expect(present).toContain(heading);
    }
  });

  it('the interview writes the boundary the groom step reads', () => {
    expect(prompt(loop('groom-intent-loop'))).toContain('## Decision boundary');
  });

  it('the groom step\'s reviewer grades against the boundary and does not reopen a logged decision on preference', () => {
    const charter = text(loop('groom-goal-loop').reviewers[0].charter);
    expect(charter).toContain('## Decision boundary');
    expect(charter).toContain('## Groomer decisions');
    expect(charter).not.toMatch(/never for it to be resolved/);
  });
});

describe('each implementation step is a goal session that reviews its own work (v2.201)', () => {
  it.each(CODE_LOOPS)('%s keeps v2\'s reviewers, charters, completion check and polish policy, and runs as a goal in legs of 3 review passes', (name) => {
    const v3 = loop(name);
    const v2 = loopV2(name);
    expect(v3.rounds).toEqual({ kind: 'none' });
    expect(v3.work.goal).toMatch(/every reviewer's latest pass found nothing left to fix/);
    expect(v3.work.checkpoint).toEqual({ passes: 3 });
    expect(v3.work.completion).toBe(v2.work.completion);
    expect(v3.report.polish).toBe(v2.report.polish);
    expect(v3.reviewers.map((r) => r.persona)).toEqual(v2.reviewers.map((r) => r.persona));
    for (const [i, r] of v3.reviewers.entries()) expect(text(r.charter)).toBe(text(v2.reviewers[i].charter));
    expect(v3.gate.map((g) => g.option)).not.toContain('request-changes');
  });

  it.each(CODE_LOOPS)('%s reads the intent the operator settled and writes its part of the implementation report', (name) => {
    const def = loop(name);
    expect(def.inputs.map((i) => i.id)).toContain('groom-intent');
    expect(def.outputs.map((o) => o.id)).toContain('impl-report');
    if (name !== 'infra-loop') expect(def.inputs.map((i) => i.id)).toContain('impl-report');
  });

  it.each([...CODE_LOOPS, 'impl-approve-loop'])('%s writes its part of the implementation report to its own section file, and reads the report assembled from every section', (name) => {
    const def = loop(name);
    const reports = [...def.inputs, ...def.outputs].filter((b) => b.id === 'impl-report');
    expect(def.outputs.map((o) => o.id)).toContain('impl-report');
    for (const b of reports) expect(b.sections?.rel, `${name} ${b.rel}`).toMatch(/\/artifacts\/impl-report$/);
    const p = prompt(def).replace(/\s+/g, ' ');
    expect(p).not.toMatch(/(section for this step to|record it in) `impl-report\.md`/);
    expect(p).toMatch(/section file/);
  });

  it.each(CODE_LOOPS)('%s never stops to ask: it decides inside the boundary and logs what it decided, found and ran', (name) => {
    const p = prompt(loop(name));
    expect(p).toContain('## Decision boundary');
    for (const heading of ['### Needs your call', '### Decisions', '### Review history', '### Test evidence']) expect(p).toContain(heading);
    expect(p).not.toMatch(/interview the operator/i);
  });

  it('the refactor step records the test result its goal session is graded on', () => {
    const p = prompt(loop('refactor-loop'));
    expect(p).not.toMatch(/not a\s+result\s+file/);
    expect(p).toMatch(/records its test result/);
  });

  it('integration-slice no longer publishes the pull request description: the final approval does', () => {
    const effects = (def: LoopDefV2) => def.gate.find((g) => g.option === 'approve')?.sideEffects ?? [];
    expect(effects(loop('integration-slice-loop'))).toEqual([{ kind: 'commit', args: { label: 'integration' } }]);
    expect(effects(loop('impl-approve-loop'))).toEqual([
      { kind: 'commit', args: { label: 'approve' } },
      { kind: 'gh', args: { action: 'publish-pr-body', artifact: 'plan' } },
    ]);
  });

  it('the final approval can send the slice back to RED, as the implementation steps can', () => {
    expect(loop('impl-approve-loop').gate.map((g) => g.option)).toContain('back-to-red');
  });

  it('the final approval presents what every implementation step logged', () => {
    const approve = loop('impl-approve-loop');
    expect(approve.rounds).toEqual({ kind: 'none' });
    expect(approve.inputs.map((i) => i.id)).toEqual(expect.arrayContaining(['groom-intent', 'plan', 'impl-report']));
    const present = prompt(approve);
    for (const heading of ['## Needs your call', '## Decisions', '## Review history', '## Test evidence']) expect(present).toContain(heading);
  });

  it('the groom goal session also runs in legs of 3 review passes', () => {
    expect(loop('groom-goal-loop').work.checkpoint).toEqual({ passes: 3 });
  });
});

describe('planning is one goal session that reviews itself, approved once (#212)', () => {
  const v2Bundle = () => loopV2('plan-bundle-loop');
  const v2Polish = () => loopV2('plan-polish-loop');

  it('the plan step is a goal session in legs of 3 that reviews with all 9 plan-polish reviewers', () => {
    const goal = loop('plan-goal-loop');
    expect(goal.rounds).toEqual({ kind: 'none' });
    expect(goal.work.goal).toMatch(/every reviewer's latest pass found nothing left to fix/);
    expect(goal.work.checkpoint).toEqual({ passes: 3 });
    expect(goal.reviewers.map((r) => r.persona)).toEqual(v2Polish().reviewers.map((r) => r.persona));
    for (const [i, r] of goal.reviewers.entries()) expect(text(r.charter)).toBe(text(v2Polish().reviewers[i].charter));
    expect(goal.gate.map((g) => g.option)).not.toContain('request-changes');
  });

  it('the plan step picks the ticket up as plan-bundle did, creating the branch and draft PR every later step uses', () => {
    expect(loop('plan-goal-loop').pickup).toEqual(v2Bundle().pickup);
    expect(loop('plan-goal-loop').pickup).not.toBeNull();
  });

  it('the plan step reads the groomed ticket and the intent, and writes the plan and its report', () => {
    const goal = loop('plan-goal-loop');
    expect(goal.inputs.map((i) => i.id).sort()).toEqual(['groom-intent', 'groomed-ticket']);
    expect(goal.outputs.map((o) => o.id).sort()).toEqual(['plan', 'plan-report']);
    expect(goal.work.artifact).toBe('plan');
  });

  it('the plan step drafts the planning bundle, keeping every section and machine-read token the gates read', () => {
    const p = prompt(loop('plan-goal-loop'));
    for (const heading of ['## Test plan', '## Technical plan', '## Infrastructure plan', '## Slice plan', '## Complexity drivers', '### Slice sizing']) {
      expect(text(v2Bundle().work.recipe) + brief(v2Bundle())).toContain(heading);
      expect(p, heading).toContain(heading);
    }
    for (const token of [...Object.values(EPIC_GRAMMAR), ...Object.values(SLICE_GRAMMAR)]) expect(p, token).toContain(token);
  });

  it('the plan step embeds the canonical epic and impl-slices examples the gates accept', () => {
    const fences = [...brief(loop('plan-goal-loop')).matchAll(/```text\n([\s\S]*?)```/g)].map((m) => m[1]);
    const epic = fences.find((f) => f.includes(EPIC_GRAMMAR.subTicketsHeading)) ?? '';
    const slices = fences.find((f) => f.includes(SLICE_GRAMMAR.implSlicesHeading)) ?? '';
    expect(epicPlanWellFormed(epic)).toBe(true);
    expect(epic.trim()).toBe(exampleEpicPlan(2).trim());
    expect(slicePlanWellFormed(slices)).toBe(true);
    expect(slices.trim()).toBe(exampleSlicePlan(2).trim());
  });

  it('the plan step polishes its own draft with the plan-polish method, carried verbatim', () => {
    const v2Recipe = text(v2Polish().work.recipe);
    const method = v2Recipe.slice(v2Recipe.indexOf('# Plan Polish'));
    expect(method.length).toBeGreaterThan(1000);
    expect(prompt(loop('plan-goal-loop'))).toContain(method.trim());
  });

  it('the plan step never stops to ask: it decides inside the boundary and lists the rest for the operator', () => {
    const p = prompt(loop('plan-goal-loop'));
    for (const heading of ['## Decision boundary', '## Needs your call', '## Planner decisions', '## Review history']) expect(p, heading).toContain(heading);
    expect(p).not.toMatch(/interview the operator/i);
    expect(p).not.toMatch(/stops the loop for the operator/);
    expect(p).not.toMatch(/When\s+the\s+operator\s+decides/);
  });

  it('the plan step may write the report the approval step reads, and names only steps v3 has', () => {
    const p = prompt(loop('plan-goal-loop'));
    expect(p).not.toMatch(/outside\s+the\s+plan\s+artifact/);
    expect(p).toMatch(/outside\s+the\s+plan\s+and\s+`plan-report\.md`/);
    expect(p).not.toContain('plan-bundle');
  });

  it('the approval step presents what the plan step logged', () => {
    const approve = loop('plan-approve-loop');
    expect(approve.rounds).toEqual({ kind: 'none' });
    expect(approve.reviewers).toEqual([]);
    expect(approve.inputs.map((i) => i.id).sort()).toEqual(['groom-intent', 'groomed-ticket', 'plan', 'plan-report']);
    const present = prompt(approve);
    expect(present).toContain('Operator decision (<date>)');
    for (const token of [...Object.values(EPIC_GRAMMAR), ...Object.values(SLICE_GRAMMAR)]) expect(present, token).toContain(token);
    for (const heading of ['## Needs your call', '## Planner decisions', '## Review history']) {
      expect(prompt(loop('plan-goal-loop'))).toContain(heading);
      expect(present, heading).toContain(heading);
    }
  });

  it('approving the plan marks the PR ready and promotes the plan, as plan-polish did, and re-sources the slice count', () => {
    const effects = (def: LoopDefV2) => def.gate.find((g) => g.option === 'approve')?.sideEffects ?? [];
    const approve = loop('plan-approve-loop');
    expect(effects(approve)).toEqual(effects(v2Polish()));
    expect(effects(approve)).toEqual([
      { kind: 'gh', args: { action: 'mark-ready' } },
      { kind: 'promote', args: { artifact: 'plan' } },
    ]);
    expect(approve.outputs.find((o) => o.id === 'plan')?.path).toBe(loop('plan-goal-loop').outputs.find((o) => o.id === 'plan')?.path);
  });
});
