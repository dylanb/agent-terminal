import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';
import { EPIC_GRAMMAR, epicPlanWellFormed, exampleEpicPlan } from '../../src/shared/epicPlan';
import { exampleSlicePlan, slicePlanWellFormed, SLICE_GRAMMAR } from '../../src/shared/slicePlan';
import { GOAL_NO_CHANGE_CLAUSE } from '../../src/main/reviewTurn';
import { REPORT_SECTION_HEADING } from '../../src/main/appWorkTurn';
import { redTestChangesArtifact } from '../../src/main/redTestChanges';

// feature-dev-v3 (v2.200, v2.201) — grooming in three steps: an interview that settles
// the intent and what may be decided without the operator, a goal session that grooms and reviews until a review
// pass finds nothing, and a presentation the operator approves as is or fixes in that same session. Each
// implementation step is then a goal session that reviews its own work and logs its decisions, and one final
// step presents them all for the operator's approval. Planning (#212) is one goal session that drafts, polishes and
// reviews the plan, and a presentation the operator approves once.

const FLOWS = resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR });
const V3 = 'feature-dev-v3';
const CODE_LOOPS = ['infra-loop', 'red-loop', 'green-loop', 'refactor-loop', 'integration-slice-loop'];

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
const flat = (s: string): string => s.replace(/\s+/g, ' ');

describe('feature-dev-v3 grooms in three steps, and approves the implementation once at the end', () => {
  it('runs the three groom steps, the two planning steps, the code steps, and the implementation approval before finalize', () => {
    expect(flow(V3).steps.map((s) => [s.id, s.kind, s.kind === 'loop' ? s.loop : null])).toEqual([
      ['preparation', 'manual', null],
      ['groom-intent', 'loop', 'groom-intent-loop'],
      ['groom', 'loop', 'groom-goal-loop'],
      ['groom-approve', 'loop', 'groom-approve-loop'],
      ['plan', 'loop', 'plan-goal-loop'],
      ['plan-approve', 'loop', 'plan-approve-loop'],
      ['infra', 'loop', 'infra-loop'],
      ['red', 'loop', 'red-loop'],
      ['green', 'loop', 'green-loop'],
      ['refactor', 'loop', 'refactor-loop'],
      ['integration-slice', 'loop', 'integration-slice-loop'],
      ['impl-approve', 'loop', 'impl-approve-loop'],
      ['finalize', 'loop', expect.any(String)],
    ]);
  });

  it('retains human approval for grooming, planning, implementation and finalization', () => {
    const humans = flow(V3).steps.filter((s) => s.kind === 'loop' && s.gateAuthority !== 'auto').map((s) => s.id);
    expect(humans).toEqual(['groom-approve', 'plan-approve', 'impl-approve', 'finalize']);
  });

  it('asks for the ticket at the interview, and leaves only the approval to a human', () => {
    const steps = flow(V3).steps;
    const byId = (id: string) => steps.find((s) => s.id === id)!;
    expect(byId('groom-intent').inputs?.map((i) => i.name)).toEqual(['ticket']);
    expect(byId('groom-intent').gateAuthority).toBe('auto');
    expect(byId('groom').gateAuthority).toBe('auto');
    expect(byId('groom-approve').gateAuthority).toBe('human');
  });

  it('ships exactly the loops its steps run', () => {
    const v3Loops = readdirSync(join(BUNDLED_LOOPS_ROOT, V3));
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
    expect(goal.work.goal).toContain(GOAL_NO_CHANGE_CLAUSE);
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
  const CODE_LOOP_SHAPE: Record<string, { completion: string | null; polish: string; personas: string[] }> = {
    'infra-loop': {
      completion: null,
      polish: 'defer',
      personas: [...['principal', 'tests', 'security', 'taint', 'reliability', 'maintainability', 'conventions', 'architecture'].map((l) => `impl-review-${l}`), 'review-plan-determinism'],
    },
    'red-loop': { completion: 'red', polish: 'defer', personas: ['impl-review-tests', 'impl-review-intent', 'impl-review-red-authenticity'] },
    'green-loop': {
      completion: 'green',
      polish: 'defer',
      personas: [...['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'accessibility', 'regression-guard'].map((l) => `impl-review-${l}`)],
    },
    'refactor-loop': { completion: 'refactor', polish: 'defer', personas: ['principal', 'tests', 'reliability', 'architecture'].map((l) => `impl-review-${l}`) },
    'integration-slice-loop': {
      completion: null,
      polish: 'fix',
      personas: [
        ...['principal', 'tests', 'security', 'taint', 'reliability', 'architecture', 'contracts', 'intent', 'maintainability', 'conventions', 'accessibility', 'diagrams'].map((l) => `impl-review-${l}`),
        'review-plan-tracer-slicer',
      ],
    },
  };

  it.each(CODE_LOOPS)('%s keeps its reviewers, completion check and polish policy, and runs as a goal in legs of 3 review passes', (name) => {
    const v3 = loop(name);
    const want = CODE_LOOP_SHAPE[name];
    expect(v3.rounds).toEqual({ kind: 'none' });
    expect(v3.work.goal).toContain(GOAL_NO_CHANGE_CLAUSE);
    expect(v3.work.checkpoint).toEqual({ passes: 3 });
    expect(v3.work.completion ?? null).toBe(want.completion);
    expect(v3.report.polish).toBe(want.polish);
    expect(v3.reviewers.map((r) => r.persona)).toEqual(want.personas);
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
    for (const b of reports) expect(b.sectionsDir?.rel, `${name} ${b.rel}`).toMatch(/\/artifacts\/impl-report$/);
    const p = prompt(def).replace(/\s+/g, ' ');
    expect(p).not.toMatch(/(section for this step to|record it in) `impl-report\.md`/);
    expect(p).toMatch(/section file/);
    expect(p).toContain(`named under ${REPORT_SECTION_HEADING} in your turn instructions`);
    if (name !== 'impl-approve-loop') {
      expect(def.work.goal).not.toContain('impl-report.md');
      expect(def.work.goal).toMatch(/report section file holds/);
    }
  });

  it('the green goal no longer bars a change to a RED test: it requires each one logged', () => {
    const goal = loop('green-loop').work.goal ?? '';
    expect(goal).not.toContain('no line of a RED test changed or removed');
    expect(goal).toContain('every change to a line of a RED test is logged under `### RED test changes`');
  });

  it('green may add tests that test behaviour and weaken no other test, seen failing first', () => {
    const work = flat(text(loop('green-loop').work.recipe));
    expect(work).toMatch(/You may add new tests/);
    expect(work).toMatch(/must test observable behaviour, never the implementation, and must not weaken any other test/);
    expect(work).toMatch(/run it to see it fail/);
  });

  it.each(['green-loop', 'refactor-loop', 'integration-slice-loop'])('%s decides a change to a RED test itself and logs it, unless it leaves an acceptance criterion untested', (name) => {
    const p = flat(prompt(loop(name)));
    expect(p).not.toContain('Never change or remove a line of a test RED wrote');
    expect(p).not.toContain('a change to or removal of a line of a test RED wrote');
    expect(p).not.toContain('an edit to a test that is frozen at this point');
    expect(p).toContain('A change to a line of a test RED wrote is yours to decide');
    expect(p).toContain('a change to a RED test that leaves an acceptance criterion with no test that checks it');
    expect(p).toContain('### RED test changes');
    expect(p).toMatch(/`### RED test changes` — each test file whose RED lines you changed or removed: what changed, why, and why every acceptance criterion it checked is still checked/);
  });

  it('green\'s regression-guard reviewer grades the tests GREEN added and every RED test change it logged', () => {
    const charter = flat(text(loop('green-loop').reviewers.find((r) => r.persona === 'impl-review-regression-guard')!.charter));
    expect(charter).toMatch(/For each test GREEN added, confirm it weakens no other test/);
    expect(charter).toMatch(/tests observable behavior, not the implementation, and was seen failing before the code it covers/);
    expect(charter).toMatch(/For each change to a RED test, judge whether it corrects a wrong test or weakens a right one/);
    expect(charter).toMatch(/a changed test file the flag lists that `### RED test changes` does not explain is a finding/);
  });

  it.each(['refactor-loop', 'integration-slice-loop'])('%s\'s tests reviewer grades every RED test change the step logged', (name) => {
    const charter = flat(text(loop(name).reviewers.find((r) => r.persona === 'impl-review-tests')!.charter));
    expect(charter).toMatch(/For each change to a RED test, judge whether it corrects a wrong test or weakens a right one/);
  });

  it('integration-slice runs the engine\'s frozen check at its approve, as GREEN and refactor do', () => {
    expect(loop('integration-slice-loop').work.frozenCheck).toBe(true);
    expect(loop('green-loop').work.frozenCheck).toBeUndefined();
  });

  it.each(CODE_LOOPS)('%s never stops to ask: it decides inside the boundary and logs what it decided, found and ran', (name) => {
    const p = prompt(loop(name));
    expect(p).toContain('## Decision boundary');
    for (const heading of ['### Needs your call', '### Decisions', '### Review history', '### Test evidence']) expect(p).toContain(heading);
    expect(p).not.toMatch(/interview the operator/i);
  });

  it.each(CODE_LOOPS)('%s records its test evidence before the first review pass, and again after a fix that changes code or tests', (name) => {
    const recipe = flat(text(loop(name).work.recipe));
    const evidence = recipe.search(/under `### Test evidence` before any review/);
    expect(evidence).toBeGreaterThan(-1);
    expect(evidence).toBeLessThan(recipe.search(/Review it with the reviewers below/));
    expect(recipe).toMatch(/When a fix changes code or tests, run the tests again and update `### Test evidence` before the next pass/);
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

  it('the final approval lists every RED test change the engine recorded, with the step\'s reason or marked unexplained', () => {
    const approve = loop('impl-approve-loop');
    const record = approve.inputs.find((i) => i.id === 'red-test-changes');
    expect(record?.path).toBe(redTestChangesArtifact(REPO_DIR));
    const present = flat(prompt(approve));
    expect(present).toContain('## RED test changes');
    expect(present).toMatch(/every path in the `red-test-changes` input/);
    expect(present).toContain('**Unexplained**');
    expect(present.indexOf('## RED test changes')).toBeLessThan(present.indexOf('## What was built'));
    expect(present.indexOf('## Needs your call')).toBeLessThan(present.indexOf('## RED test changes'));
  });

  it('the groom goal session also runs in legs of 3 review passes', () => {
    expect(loop('groom-goal-loop').work.checkpoint).toEqual({ passes: 3 });
  });
});

describe('planning is one goal session that reviews itself, approved once (#212)', () => {
  it('the plan step is a goal session in legs of 3 that reviews with all 10 plan reviewers', () => {
    const goal = loop('plan-goal-loop');
    expect(goal.rounds).toEqual({ kind: 'none' });
    expect(goal.work.goal).toContain(GOAL_NO_CHANGE_CLAUSE);
    expect(goal.work.checkpoint).toEqual({ passes: 3 });
    expect(goal.reviewers.map((r) => r.persona)).toEqual(
      ['principal', 'security', 'architecture', 'intent', 'maintainability', 'contracts', 'test-architect', 'determinism', 'tracer-slicer', 'ui'].map((l) => `review-plan-${l}`),
    );
    expect(goal.gate.map((g) => g.option)).not.toContain('request-changes');
  });

  it('the plan step picks the ticket up, creating the branch and draft PR every later step uses', () => {
    expect(loop('plan-goal-loop').pickup).toEqual({
      initialStatus: 'planning',
      branchTemplate: 'plan-loop/issue-{issue}',
      initialLabels: [
        { action: 'remove', target: 'issue', label: 'plan-loop/ready' },
        { action: 'add', target: 'issue', label: 'plan-loop/in-progress' },
        { action: 'add', target: 'pr', label: 'plan-loop/plan-draft' },
      ],
      wipe: { mode: 'wipe-and-retry' },
    });
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

  it('the plan step never stops to ask: it decides inside the boundary and lists the rest for the operator', () => {
    const p = prompt(loop('plan-goal-loop'));
    for (const heading of ['## Decision boundary', '## Needs your call', '## Planner decisions', '## Review history']) expect(p, heading).toContain(heading);
    expect(p).not.toMatch(/interview the operator/i);
    expect(p).not.toMatch(/stops the loop for the operator/);
    expect(p).not.toMatch(/When\s+the\s+operator\s+decides/);
  });

  it('the plan step schedules every edit to an existing test in the RED step of the slice that needs it, and the tracer-slicer checks it', () => {
    const rule = /edit to or deletion of an existing test that a slice needs in that slice's RED step, never its GREEN or refactor step/;
    expect(flat(text(loop('plan-goal-loop').work.recipe))).toMatch(rule);
    const slicer = loop('plan-goal-loop').reviewers.find((r) => r.persona === 'review-plan-tracer-slicer');
    expect(flat(text(slicer!.charter))).toMatch(/edit to or deletion of an existing test that a slice needs belongs in that slice's RED step[\s\S]*? Any such edit scheduled in a GREEN or refactor step is a finding/);
    for (const t of [text(slicer!.charter), text(loop('plan-goal-loop').work.recipe), text(loop('integration-slice-loop').reviewers.find((r) => r.persona === 'review-plan-tracer-slicer')?.charter ?? slicer!.charter)]) {
      expect(flat(t)).not.toMatch(/engine halts an `auto` GREEN or refactor gate/);
    }
  });

  it('the plan step re-reviews only the reviewers a fix concerns, and every reviewer only when a fix changes the plan\'s scope', () => {
    expect(flat(text(loop('plan-goal-loop').work.recipe))).toMatch(
      /A later pass runs only the reviewers whose findings you fixed and any whose area your fixes touched, and every reviewer again only when a fix changes the plan's acceptance criteria, scope, approach or slices/,
    );
  });

  it.each(['groom-goal-loop', 'plan-goal-loop', ...CODE_LOOPS])('%s ends its review on a pass that changed nothing, never on a count of findings', (name) => {
    const p = flat(prompt(loop(name)));
    expect(p).not.toMatch(/finds nothing left to fix|returns no findings/);
    expect(p).toMatch(/until the review ends, as the review rules in these instructions say/);
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

  it('approving the plan marks the PR ready and promotes the plan, and re-sources the slice count', () => {
    const effects = (def: LoopDefV2) => def.gate.find((g) => g.option === 'approve')?.sideEffects ?? [];
    const approve = loop('plan-approve-loop');
    expect(effects(approve)).toEqual([
      { kind: 'gh', args: { action: 'mark-ready' } },
      { kind: 'promote', args: { artifact: 'plan' } },
    ]);
    expect(approve.outputs.find((o) => o.id === 'plan')?.path).toBe(loop('plan-goal-loop').outputs.find((o) => o.id === 'plan')?.path);
  });
});
