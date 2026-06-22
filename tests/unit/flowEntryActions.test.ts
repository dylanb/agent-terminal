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

// §24.2.3 T3 — a step with `bootstrap: pickup` resolves its required typed inputs (§18.4) on entry.
// When a required input is unsatisfied the action returns a `prompt` (the modal collects it) and
// injects nothing; once every required input is provided it injects `agent-loop pickup <input>`
// (§18.3), subject to the same §19.3 busy refusal as the skill. The resolved inputs arrive as the
// second argument (threaded by the machine from flow-state).
describe('flow entry actions — bootstrap pickup (§24.2.3 T3 / §18.3/§18.4)', () => {
  const planStep = (over: Partial<FlowStepDef> = {}): FlowStepDef =>
    step({ id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }], ...over });

  it('prompts for an unsatisfied required input and injects nothing', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep(), {});
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: BOOTSTRAP_PICKUP });
    expect(result.notice).toBeUndefined();
  });

  it('injects `agent-loop pickup <input>` once the required input is provided', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep(), { ticket: '176' });
    expect(d.inject).toHaveBeenCalledWith('agent-loop pickup 176');
    expect(result.prompt).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('refuses the bootstrap over a busy shell, injecting nothing (§19.3)', () => {
    const d = deps({ isShellBusy: vi.fn(() => true) });
    const result = createFlowEntryActions(d)(planStep(), { ticket: '176' });
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBe(BUSY_NOTICE);
    expect(result.prompt).toBeUndefined();
  });

  it('does not prompt for an optional (non-required) input', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep({ inputs: [{ name: 'note', type: 'free-text', required: false }] }), {});
    expect(result.prompt).toBeUndefined();
    expect(d.inject).toHaveBeenCalledWith('agent-loop pickup');
  });

  it('treats a reserved prototype-chain input name as unsatisfied (no [object Object] injection)', () => {
    const d = deps();
    // `inputs['__proto__']` is truthy via the prototype chain even though nothing was resolved; an
    // own-property check must still see it as missing and prompt, never inject `[object Object]`.
    const result = createFlowEntryActions(d)(
      planStep({ inputs: [{ name: '__proto__', type: 'free-text', required: true }] }),
      {},
    );
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: '__proto__', type: 'free-text' }], bootstrap: BOOTSTRAP_PICKUP });
  });

  it('trims a resolved input value before injecting it', () => {
    const d = deps();
    createFlowEntryActions(d)(planStep(), { ticket: '  176  ' });
    expect(d.inject).toHaveBeenCalledWith('agent-loop pickup 176');
  });

  it('prompts when a required input is present but blank/whitespace-only', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(planStep(), { ticket: '   ' });
    expect(d.inject).not.toHaveBeenCalled();
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
