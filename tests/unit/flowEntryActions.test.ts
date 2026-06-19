import { describe, expect, it, vi } from 'vitest';
import { createFlowEntryActions, skillInvocation, BUSY_NOTICE } from '../../src/main/flowEntryActions';
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

describe('skillInvocation', () => {
  it('prefixes a bare skill name with a slash', () => {
    expect(skillInvocation('groom')).toBe('/groom');
  });
  it('leaves an already-slashed invocation untouched', () => {
    expect(skillInvocation('/groom')).toBe('/groom');
  });
});
