import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveExampleFlowsDir } from '../../src/main/exampleAssets';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { BUNDLED_LOOPS_ROOT, REPO_DIR } from '../helpers/bundledLoops';

// feature-dev-v3 (v2.200) — feature-dev-v2 with grooming split into three steps: an interview that settles the
// intent and what the groomer may decide alone, a goal session that grooms and reviews until a review pass finds
// nothing, and a presentation the operator approves as is or fixes in that same session.

const FLOWS = resolveExampleFlowsDir({ packaged: false, appPath: REPO_DIR });
const V2 = 'feature-dev-v2';
const V3 = 'feature-dev-v3';
const GROOM_STEPS = ['groom-intent', 'groom', 'groom-approve'];

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

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? files(p).map((f) => join(e, f)) : [e];
  });
}

describe('feature-dev-v3 grooms in three steps, then runs feature-dev-v2 unchanged', () => {
  it('replaces v2\'s one groom step with the three, and keeps every other step as v2 has it', () => {
    const v2 = flow(V2).steps;
    const v3 = flow(V3).steps;
    const groomAt = v2.findIndex((s) => s.id === 'groom');
    expect(v3.map((s) => s.id)).toEqual([...v2.slice(0, groomAt).map((s) => s.id), ...GROOM_STEPS, ...v2.slice(groomAt + 1).map((s) => s.id)]);
    expect(v3.filter((s) => !GROOM_STEPS.includes(s.id))).toEqual(v2.filter((s) => s.id !== 'groom'));
  });

  it('asks for the ticket at the interview, and leaves only the approval to a human', () => {
    const steps = flow(V3).steps;
    const byId = (id: string) => steps.find((s) => s.id === id)!;
    expect(byId('groom-intent').inputs?.map((i) => i.name)).toEqual(['ticket']);
    expect(byId('groom-intent').gateAuthority).toBe('auto');
    expect(byId('groom').gateAuthority).toBe('auto');
    expect(byId('groom-approve').gateAuthority).toBe('human');
  });

  it('copies every loop v2 binds after grooming, byte for byte', () => {
    const v2Loops = readdirSync(join(BUNDLED_LOOPS_ROOT, V2)).filter((l) => l !== 'groom-loop');
    for (const l of v2Loops) {
      const src = join(BUNDLED_LOOPS_ROOT, V2, l);
      const dst = join(BUNDLED_LOOPS_ROOT, V3, l);
      for (const f of files(src)) expect(text(join(dst, f)), relative(BUNDLED_LOOPS_ROOT, join(dst, f))).toBe(text(join(src, f)));
    }
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
