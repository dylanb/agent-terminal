import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createFlowManager, flowCatalogDir, type FlowInputDef } from '../../src/main/flow';
import { createFlowEntryActions } from '../../src/main/flowEntryActions';
import { createRunResolver } from '../../src/main/runResolver';
import { createActiveFlowGate } from '../../src/main/activeFlowGate';
import { createWorktreeLock, worktreeLockRoot } from '../../src/main/worktreeLock';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { repoOnlyDefTiers } from '../helpers/defTiers';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';

// A3 (#134) §18.4 / §18.7.4 AC5 — after Terminate, switching the worktree to another flow and starting it
// resolves that flow's own step-0 inputs: nothing carried from the terminated flow's inputs survives the switch.
// Drives the production flow manager, run resolver and active-flow gate over real fixtures.

describe('switching flows after Terminate resolves the new flow’s own step-0 inputs (AC5)', () => {
  const fx = createWorktreeFixture();
  const catalog = createCatalogFixture();
  afterEach(() => {
    fx.cleanup();
    catalog.cleanup();
  });

  const input = (name: string, type: string): FlowInputDef => ({ name, type, required: true });

  /** A catalog entry whose step 0 is a §27 loop step declaring `inputs` — the step kind that prompts on entry. */
  function seedLoopEntry(root: string, id: string, stepId: string, inputs: FlowInputDef[]): void {
    const entry = join(flowCatalogDir(root), id);
    mkdirSync(entry, { recursive: true });
    const declared = inputs
      .map((i) => `      - name: ${i.name}\n        type: ${i.type}\n        required: ${i.required}\n`)
      .join('');
    writeFileSync(
      join(entry, FLOW_DEF_FILE),
      `name: ${id}\nsteps:\n  - id: ${stepId}\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n    inputs:\n${declared}` +
        `  - id: ${id}-after\n    kind: manual\n`,
    );
  }

  function rig() {
    const wt = fx.makeWorktree('a3-ac5-wt');
    const home = fx.makeWorktree('a3-ac5-home');
    seedLoopEntry(home, 'flow-a', 'a-first', [input('ticket', 'github-ticket')]);
    seedLoopEntry(home, 'flow-b', 'b-first', [input('pr', 'pr')]);
    const resolve = createRunResolver(home, repoOnlyDefTiers());
    const enter = createFlowEntryActions({
      isShellBusy: () => false,
      inject: () => {},
      prepareLoopBinding: () => ({ kind: 'refuse' }),
      enterAppLoop: () => {},
    });
    const flow = createFlowManager({
      globalDir: home,
      loadDefinition: (repoKey) => resolve(repoKey),
      onEnterStep: (step, inputs) => enter(step, inputs),
    });
    const gate = createActiveFlowGate(
      createWorktreeLock({ lockRoot: worktreeLockRoot(home), holderLiveness: () => 'live-matching' }),
    );
    return { wt, flow, gate };
  }

  it("flow B's Start prompts for B's `pr` only, and the view carries no `ticket` from flow A", () => {
    const { wt, flow, gate } = rig();
    writeActiveFlow(wt, 'flow-a');

    const startedA = flow.start(wt);
    expect(startedA.prompt?.inputs.map((i) => i.name)).toEqual(['ticket']);
    const answered = flow.provideInput(wt, { ticket: '176' });
    expect(answered.refs?.ticket).toBe(176);

    flow.terminate(wt);
    expect(gate.set(wt, 'flow-b')).toEqual({ ok: true });
    expect(flow.state(wt).steps).toEqual(['b-first', 'flow-b-after']);

    const startedB = flow.start(wt);
    expect(startedB.steps).toEqual(['b-first', 'flow-b-after']);
    expect(startedB.prompt?.inputs.map((i) => i.name)).toEqual(['pr']);
    expect(startedB.refs?.ticket).toBeUndefined();
    expect(flow.state(wt).refs?.ticket).toBeUndefined();
  });

  it('a switch back to flow A after Terminate prompts for `ticket` again rather than reusing the terminated answer', () => {
    const { wt, flow, gate } = rig();
    writeActiveFlow(wt, 'flow-a');
    flow.start(wt);
    flow.provideInput(wt, { ticket: '176' });
    flow.terminate(wt);
    expect(gate.set(wt, 'flow-b')).toEqual({ ok: true });
    expect(gate.set(wt, 'flow-a')).toEqual({ ok: true });

    const restarted = flow.start(wt);
    expect(restarted.prompt?.inputs.map((i) => i.name)).toEqual(['ticket']);
    expect(restarted.refs?.ticket).toBeUndefined();
  });
});
