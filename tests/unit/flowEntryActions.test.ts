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
    runPickup: vi.fn(),
    resumeLoop: vi.fn(),
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

// §26 D42a (resume --loop) — a loop step WITHOUT `bootstrap: pickup` does not create a run; it RESUMES the
// existing run under the step's bound loop def. On entry it calls the out-of-band `resumeLoop` port (which
// rebinds state.yaml + injects /clear + the first work prompt), and — like pickup — injects nothing itself
// and is not gated by the busy shell. A pickup loop step and a manual step never resume.
describe('flow entry actions — resume into a loop step (§26 D42a)', () => {
  const implStep = (over: Partial<FlowStepDef> = {}): FlowStepDef =>
    step({ id: 'implement', kind: 'loop', loop: 'impl-loop', ...over });

  it('calls resumeLoop for a loop step with no bootstrap and injects/prompts nothing', () => {
    const d = deps();
    const s = implStep();
    const result = createFlowEntryActions(d)(s, {});
    expect(d.resumeLoop).toHaveBeenCalledWith(s);
    expect(d.inject).not.toHaveBeenCalled();
    expect(d.runPickup).not.toHaveBeenCalled();
    expect(result.prompt).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  it('resumes even over a busy shell — it is out-of-band, not terminal injection', () => {
    const d = deps({ isShellBusy: vi.fn(() => true) });
    createFlowEntryActions(d)(implStep(), {});
    expect(d.resumeLoop).toHaveBeenCalled();
  });

  it('does NOT resume a loop step that bootstraps via pickup (pickup creates the run instead)', () => {
    const d = deps();
    const s = step({ id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] });
    createFlowEntryActions(d)(s, { ticket: '176' });
    expect(d.resumeLoop).not.toHaveBeenCalled();
    expect(d.runPickup).toHaveBeenCalled();
  });

  it('does NOT resume a manual step', () => {
    const d = deps();
    createFlowEntryActions(d)(step({ id: 'polish', kind: 'manual' }));
    expect(d.resumeLoop).not.toHaveBeenCalled();
  });
});

// §27.15 — a loop step bound to the `app` def namespace is the §27 engine's. The dispatcher routes it to
// the §27 entry (enterAppLoop) BEFORE any §26 skill inject, pickup runner, or resume port can fire, so the
// two engines never both run for one step (AC10). What the §27 entry does (start the work turn) is the
// engine's concern; the dispatcher only guarantees the §26 paths do not fire.
describe('flow entry actions — app-namespace step routes to the §27 engine (§27.15 / AC10)', () => {
  const appStep = (over: Partial<FlowStepDef> = {}): FlowStepDef =>
    step({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'app', ...over });

  it('routes an app-namespace loop step to §27: no §26 resume, no pickup, no injection', () => {
    const d = deps();
    const s = appStep();
    const result = createFlowEntryActions(d)(s, {});
    expect(d.enterAppLoop).toHaveBeenCalledWith(s);
    expect(d.resumeLoop).not.toHaveBeenCalled();
    expect(d.runPickup).not.toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
    expect(result.notice).toBeUndefined();
    expect(result.prompt).toBeUndefined();
  });

  it('routes an app-namespace pickup step to §27 without running §26 pickup, even with its required input resolved', () => {
    const d = deps();
    createFlowEntryActions(d)(
      appStep({ bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }),
      { ticket: '176' },
    );
    expect(d.enterAppLoop).toHaveBeenCalled();
    expect(d.runPickup).not.toHaveBeenCalled();
  });

  it('prompts before entering a §27 step whose required typed input is unresolved', () => {
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
  });

  it('routes an app-namespace step carrying a skill to §27 without injecting it', () => {
    const d = deps();
    createFlowEntryActions(d)(appStep({ skill: 'groom' }), {});
    expect(d.enterAppLoop).toHaveBeenCalled();
    expect(d.inject).not.toHaveBeenCalled();
  });

  it('a legacy-namespace loop step still resumes (the guard is app-only)', () => {
    const d = deps();
    const s = step({ id: 'plan', kind: 'loop', loop: 'plan-loop', loopNamespace: 'legacy' });
    createFlowEntryActions(d)(s, {});
    expect(d.enterAppLoop).not.toHaveBeenCalled();
    expect(d.resumeLoop).toHaveBeenCalledWith(s);
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
