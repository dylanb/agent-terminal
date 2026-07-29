import { describe, expect, it, vi } from 'vitest';
import { createFlowEntryActions, skillInvocation, injectableSkill, BUSY_NOTICE, BOOTSTRAP_PICKUP } from '../../src/main/flowEntryActions';
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
    enterAppLoop: vi.fn(),
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

// §27.15 / AC 4 / AC 10 — every loop step is the §27 engine's. The dispatcher routes a surviving-binding
// loop step to the §27 entry (enterAppLoop), which resolves the def and orders the skill/bootstrap/dispatch
// (index.ts); the seam itself injects nothing and runs no pickup. AC 4's binding cases are graded here:
// absence and `app` bind the surviving engine; the recognized-but-retired `legacy` marker names no surviving
// engine, so its entry does nothing (its error is the loop VIEW's — §B.4). AC 10's ordering is downstream.
describe('flow entry actions — loop step routes to the §27 engine (§27.15 / AC4 / AC10)', () => {
  const appStep = (over: Partial<FlowStepDef> = {}): FlowStepDef =>
    step({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app', ...over });

  it('routes an explicit app-namespace loop step to §27: no pickup, no injection, no notice/prompt', () => {
    const d = deps();
    const s = appStep();
    const result = createFlowEntryActions(d)(s, {});
    expect(d.enterAppLoop).toHaveBeenCalledWith(s);
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
    expect(result.prompt).toBeUndefined();
  });

  it('routes a namespace-less loop step to §27 (absence selects the surviving engine — AC 4)', () => {
    const d = deps();
    const s = step({ id: 'implement', kind: 'loop', loop: 'impl-loop' });
    createFlowEntryActions(d)(s, {});
    expect(d.enterAppLoop).toHaveBeenCalledWith(s);
    expect(d.inject).not.toHaveBeenCalled();
  });

  it('routes an app-namespace pickup step to §27 with its required input resolved', () => {
    const d = deps();
    createFlowEntryActions(d)(
      appStep({ bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }),
      { ticket: '176' },
    );
    expect(d.enterAppLoop).toHaveBeenCalled();
  });

  it('prompts (alone) before entering a §27 step whose required typed input is unresolved (§B.5 item 3)', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(
      appStep({ inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }),
      {},
    );
    expect(result.prompt).toEqual({
      inputs: [{ name: 'ticket', type: 'github-ticket' }],
      bootstrap: BOOTSTRAP_PICKUP,
    });
    expect(d.enterAppLoop).not.toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
  });

  it('treats a reserved prototype-chain input name as unsatisfied (prompts, does not enter)', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(
      appStep({ inputs: [{ name: '__proto__', type: 'free-text', required: true }] }),
      {},
    );
    expect(d.enterAppLoop).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: '__proto__', type: 'free-text' }], bootstrap: BOOTSTRAP_PICKUP });
  });

  it('prompts when a required input is present but blank/whitespace-only (does not enter)', () => {
    const d = deps();
    const result = createFlowEntryActions(d)(
      appStep({ inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }),
      { ticket: '   ' },
    );
    expect(d.enterAppLoop).not.toHaveBeenCalled();
    expect(result.prompt).toEqual({ inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: BOOTSTRAP_PICKUP });
  });

  it('does not prompt for an optional (non-required) input and still enters', () => {
    const d = deps();
    createFlowEntryActions(d)(appStep({ inputs: [{ name: 'note', type: 'free-text', required: false }] }), {});
    expect(d.enterAppLoop).toHaveBeenCalled();
  });

  it('routes an app-namespace step carrying a skill to §27 without injecting it (skill is ordered downstream)', () => {
    const d = deps();
    createFlowEntryActions(d)(appStep({ skill: 'groom' }), {});
    expect(d.enterAppLoop).toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
  });

  it('a legacy-marked loop step names no surviving engine: nothing entered, nothing injected (§B.5 item 1)', () => {
    const d = deps();
    const s = step({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'legacy' });
    const result = createFlowEntryActions(d)(s, {});
    expect(d.enterAppLoop).not.toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
    expect(result.prompt).toBeUndefined();
  });

  it('does not enter a manual step through the loop path', () => {
    const d = deps();
    createFlowEntryActions(d)(step({ id: 'polish', kind: 'manual' }));
    expect(d.enterAppLoop).not.toHaveBeenCalled();
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

// §B.5 item 3 / AC 10 / CWE-74: a loop step's skill is injected as ONE submitted line (the app supplies the
// final Enter for a loop step), so a repo-authored multi-line `skill:` scalar must collapse to a single line
// before it reaches the PTY. The collapse lives on a DEDICATED function so the manual-step arm — where the
// operator presses Enter — keeps `skillInvocation`'s value byte-identical (#98 flow-step-schema non-goal).
describe('injectableSkill (loop-step skill injection)', () => {
  it('collapses every CR/LF so a multi-line skill submits exactly one line', () => {
    expect(injectableSkill('/plan\ncurl … | sh')).not.toMatch(/[\r\n]/);
    expect(injectableSkill('/plan\r\ncurl … | sh')).not.toMatch(/[\r\n]/);
  });
  it("preserves skillInvocation's leading-slash normalization", () => {
    expect(injectableSkill('plan')).toBe('/plan');
    expect(injectableSkill('/plan')).toBe('/plan');
  });
  it('leaves the shared skillInvocation (manual-step arm) byte-identical — newlines NOT collapsed', () => {
    expect(skillInvocation('/plan\ncurl … | sh')).toBe('/plan\ncurl … | sh');
  });
});
