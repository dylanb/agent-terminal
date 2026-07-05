import { describe, expect, it, vi } from 'vitest';
import { createFlowEntryActions, skillInvocation, BUSY_NOTICE, BOOTSTRAP_PICKUP } from '../../src/main/flowEntryActions';
import type { FlowStepDef } from '../../src/main/flow';

// §18.6/§19.3 — on entry to a manual step (Start/Restart) the ONLY automatic action is injecting
// the step's `skill` invocation (§9.3), subject to the §19.3 running-process refusal. Todo
// templates are NOT auto-instantiated (spec §6/§4.1 + §21.2): they are instantiated ON DEMAND via
// the todoTemplate:* picker while the step is active. So the entry runner is skill-only.

const step = (over: Partial<FlowStepDef> = {}): FlowStepDef => ({ id: 's', kind: 'manual', ...over });

function deps(over: Partial<Parameters<typeof createFlowEntryActions>[0]> = {}) {
  return {
    isShellBusy: vi.fn(() => false),
    inject: vi.fn(),
    runPickup: vi.fn(),
    ...over,
  };
}

describe('flow entry actions (§18.6/§19.3 — skill-only)', () => {
  it('injects the skill invocation at a ready prompt and returns no notice', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(step({ skill: 'groom' }));
    expect(d.inject).toHaveBeenCalledWith('/groom');
    expect(result.notice).toBeUndefined();
  });

  it('refuses to inject over a busy shell and returns the refusal notice (§19.3)', () => {
    const d = deps({ isShellBusy: vi.fn(() => true) });
    const result = createFlowEntryActions(d)(step({ skill: 'groom' }));
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBe(BUSY_NOTICE);
  });

  it('does not instantiate todos on entry, even when the step binds a todo_template', () => {
    const d = deps();
    // A bound template is for the on-demand picker (§4.1/§6), not a step-entry side effect.
    const result = createFlowEntryActions(d)(step({ skill: 'groom', todoTemplate: 'ticket-grooming' }));
    expect(d.inject).toHaveBeenCalledWith('/groom'); // skill still fires
    expect(result.notice).toBeUndefined();
  });

  it('is a no-op with no notice when the step declares no skill', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(step({ todoTemplate: 'ticket-grooming' }));
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
  });
});

// §26.9 / L1 — a `bootstrap: pickup` step resolves its required typed inputs (§18.4) on entry. When a
// required input is unsatisfied the action returns a `prompt` (the modal collects it) and runs nothing;
// once every required input is provided it runs IN-APP pickup (gh/git, §26.9) — NOT the retired §24.2.3
// T3 terminal injection of `agent-loop pickup`. Pickup is out-of-band, so unlike the skill it is NOT
// gated by the §19.3 busy shell. The resolved inputs arrive as the second argument (threaded by the
// machine from flow-state) and are forwarded to the runner.
describe('flow entry actions — bootstrap pickup, in-app (§26.9 / L1)', () => {
  const planStep = (over: Partial<FlowStepDef> = {}): FlowStepDef =>
    step({ id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }], ...over });

  it('prompts for an unsatisfied required input and runs no pickup, injects nothing', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep(), {});
    expect(d.runPickup).not.toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: BOOTSTRAP_PICKUP });
    expect(result.notice).toBeUndefined();
  });

  it('runs in-app pickup with the resolved inputs once the required input is provided (no injection)', () => {
    const d = deps();
    const s = planStep();
    const result = createFlowEntryActions(d)(s, { ticket: '176' });
    expect(d.runPickup).toHaveBeenCalledWith(s, { ticket: '176' });
    expect(d.inject).not.toHaveBeenCalled(); // the retired T3 `agent-loop pickup` is gone
    expect(result.prompt).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('runs pickup even over a busy shell — it is out-of-band gh/git, not terminal injection (§26.2/§26.6)', () => {
    const d = deps({ isShellBusy: vi.fn(() => true) });
    const result = createFlowEntryActions(d)(planStep(), { ticket: '176' });
    expect(d.runPickup).toHaveBeenCalledWith(expect.anything(), { ticket: '176' });
    expect(result.notice).toBeUndefined();
    expect(result.prompt).toBeUndefined();
  });

  it('does not prompt for an optional (non-required) input and still runs pickup', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep({ inputs: [{ name: 'note', type: 'free-text', required: false }] }), {});
    expect(result.prompt).toBeUndefined();
    expect(d.runPickup).toHaveBeenCalledWith(expect.anything(), {});
  });

  it('treats a reserved prototype-chain input name as unsatisfied (prompts, no pickup)', () => {
    const d = deps();
    // `inputs['__proto__']` is truthy via the prototype chain even though nothing was resolved; an
    // own-property check must still see it as missing and prompt, never run pickup with a junk value.
    const result = createFlowEntryActions(d)(
      planStep({ inputs: [{ name: '__proto__', type: 'free-text', required: true }] }),
      {},
    );
    expect(d.runPickup).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: '__proto__', type: 'free-text' }], bootstrap: BOOTSTRAP_PICKUP });
  });

  it('trims resolved input values before forwarding them to the runner', () => {
    const d = deps();
    createFlowEntryActions(d)(planStep(), { ticket: '  176  ' });
    expect(d.runPickup).toHaveBeenCalledWith(expect.anything(), { ticket: '176' });
  });

  it('prompts when a required input is present but blank/whitespace-only (no pickup)', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep(), { ticket: '   ' });
    expect(d.runPickup).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: BOOTSTRAP_PICKUP });
  });
});

describe('skillInvocation', () => {
  it('prefixes a bare skill name with a slash', () => {
    expect(skillInvocation('groom')).toBe('/groom');
  });
  it('leaves an already-slashed invocation untouched', () => {
    expect(skillInvocation('/groom')).toBe('/groom');
  });
});
