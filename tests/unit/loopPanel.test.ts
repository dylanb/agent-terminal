// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowAutoGateView, FlowLoopView, GithubRef, GithubRefKind } from '../../src/shared/ipc';
import { autoHaltReasonLabel } from '../../src/shared/gateAuthority';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// §24.2.3 T2 — the docked loop panel organism (UI-STANDARDS §1.2): the EXPANDED read-only loop
// read-out that the rail's compact Loop read-out opens. It renders the engine-neutral `FlowLoopView`
// vocabulary (status / iteration / pr / branch) at 100% fidelity to design/shell/loop-flow.html's State section.
// (The gate decision section + LoopDef gate options are T5/T6.) It is placement-agnostic: it touches
// only its host subtree and renders identically wherever it is mounted. Tests assert rendered DOM.

const loop = (over: Partial<FlowLoopView> = {}): FlowLoopView => ({
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  pr: 179,
  branch: 'agent-loop/issue-176',
  ready: false,
  ...over,
});

let host: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<aside id="loop-panel"></aside>';
  host = document.getElementById('loop-panel')!;
});
afterEach(() => {
  document.body.innerHTML = '';
});

const row = (key: string): HTMLElement | undefined =>
  [...host.querySelectorAll<HTMLElement>('.ldl .lrow')].find((r) => r.querySelector('.lk')?.textContent === key);

describe('docked loop panel (§24.2.3 T2)', () => {
  it('renders the loop-view rows from the loop view', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('awaiting-human-pr-approval');
    expect(row('iteration')?.querySelector('.lv')?.textContent).toBe('9');
    expect(row('pr')?.querySelector('.lv')?.textContent).toBe('#179');
    expect(row('branch')?.querySelector('.lv')?.textContent).toBe('agent-loop/issue-176');
  });

  it('shows the error reason so a stopped loop says WHY, not a bare "error" (§27.12)', () => {
    createLoopPanel(host).render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'build');
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('error');
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('no Claude at the prompt');
  });

  it('shows no reason row when the loop is not in error (the reason is error-only)', () => {
    createLoopPanel(host).render(loop({ status: 'plan-draft' }), 'build');
    expect(row('reason')).toBeUndefined();
  });

  it('removes the reason row in place when the status recovers from error (structural rebuild)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'build');
    expect(row('reason')).toBeDefined();
    panel.render(loop({ status: 'plan-draft' }), 'push');
    expect(row('reason')).toBeUndefined();
  });

  it('marks the live state region polite so a turn advance is announced to assistive tech (WCAG 4.1.3)', () => {
    // The "mark turn complete" control (and any orchestrator transition) changes the status/iteration
    // rows in place via patchInPlace without moving focus; without a live region that change is silent
    // to a screen reader. The region that holds those rows must be aria-live=polite, like .refs.
    createLoopPanel(host).render(loop(), 'build');
    expect(host.querySelector('.ldl')?.getAttribute('aria-live')).toBe('polite');
  });

  it('makes each state row atomic so a live update announces label+value together, not a bare value (WCAG 4.1.3)', () => {
    // patchInPlace mutates only the value node (.lv); without aria-atomic on the row, a screen reader
    // announces a context-free value ("3") with no field label. aria-atomic on each .lrow makes the
    // whole row ("iteration 3") announce together.
    createLoopPanel(host).render(loop(), 'build');
    const rows = [...host.querySelectorAll<HTMLElement>('.ldl .lrow')];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.getAttribute('aria-atomic')).toBe('true');
  });

  it('renders the panel header title + a close button the shell can dismiss', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(host.querySelector('.lhead h3')?.textContent).toBe('build');
    expect(host.querySelector('[data-loop-close]')).not.toBeNull();
  });

  it('locates the close control by a hook attribute, never a global id (two panels, one document)', () => {
    const a = document.createElement('aside');
    const b = document.createElement('aside');
    document.body.append(a, b);
    createLoopPanel(a).render(loop(), 'build');
    createLoopPanel(b).render(loop(), 'build');
    // Two panels in one document must not collide on a global id (invalid HTML, ambiguous selectors).
    expect(document.querySelectorAll('#lclose').length).toBe(0);
    expect(document.querySelectorAll('[data-loop-close]').length).toBe(2);
    expect(a.querySelectorAll('[data-loop-close]').length).toBe(1);
    expect(b.querySelectorAll('[data-loop-close]').length).toBe(1);
  });

  // WCAG 2.1 SC 4.1.3 (Status Messages). Assistive tech does not announce content that already exists when
  // a live region is registered. Rebuilding `.ldl` to enter `error` therefore produces SILENCE at exactly
  // the moment the turn failed. The region must survive, so the reason row is announced as an addition.
  it('keeps the live region alive when the loop enters error, and adds the reason into it', () => {
    const panel = createLoopPanel(host);

    panel.render(loop({ status: 'impl-draft' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;
    expect(row('reason')).toBeUndefined();

    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore); // same live region → the addition is announced
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('no Claude at the prompt');
  });

  it('removes the reason row when the loop recovers out of error', () => {
    const panel = createLoopPanel(host);

    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;

    panel.render(loop({ status: 'impl-draft' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore);
    expect(row('reason')).toBeUndefined();
  });

  it('updates a changed reason without replacing the live region', () => {
    const panel = createLoopPanel(host);

    panel.render(loop({ status: 'error', errorReason: 'first reason' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;

    panel.render(loop({ status: 'error', errorReason: 'second reason' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore);
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('second reason');
  });

  it('focuses its own gate decision on request, so the shell need not know the gate markup (WCAG 2.4.3)', () => {
    // The alert routes the human ONTO the decision; the panel owns which control that is, rather than a
    // sibling reaching into its DOM for [data-gate-option] (UI-STANDARDS §2.2 rule 4). A §27 gate view
    // (carrying appTurn + appGateDecision) is the only shape that renders clickable gate controls.
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {} });
    panel.render(loop({ status: 'complete', actionable: true, gateOptions: ['approve', 'request-changes', 'impasse'], appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, iteration: 2 }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-gate-option="approve"]'));
  });

  it('falls back to the work-turn route-out when the human-needed state is an error, not a gate (WCAG 2.4.3)', () => {
    // `error` is human-needed but shows the §27 route-out group, not gate options. The blocked human must
    // still land on the panel's actionable control, not be left on the alert button. syncRetry is gone, so
    // the route-out group's first button is the surviving focus target on a §27 error view carrying a turn.
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appRouteOut: () => {} });
    panel.render(loop({ status: 'error', errorReason: 'stalled', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-app-route-out]'));
  });

  // WCAG 2.4.3 / 2.1.1 (AC 9, §B.9): the two retired controls that used to render on an ERROR view carrying a
  // round — the mark-complete button (the panel's last tab stop) and syncRetry's recovery Retry — are BOTH
  // gone. The delta is per branch (two here), the case a single flat tab-stop number would miss: the
  // surviving keyboard-reachable controls are exactly the §27 work-turn route-out group and the Close entry.
  it('leaves no retired mark-complete or recovery-Retry tab stop on an error-with-round view (WCAG 2.4.3, AC 9)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appRouteOut: () => {} });
    panel.render(loop({ status: 'error', errorReason: 'stalled', iteration: 2, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(host.querySelector('[data-loop-retry]')).toBeNull(); // syncRetry's recovery Retry is gone
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('button')];
    expect(buttons.some((b) => /mark\s+(turn\s+)?complete/i.test(b.textContent ?? ''))).toBe(false); // mark-complete gone
    // the surviving tab stops are exactly the §27 route-out controls + the stable Close entry — nothing retired
    const routeOut = [...host.querySelectorAll('[data-app-route-out]')];
    const close = host.querySelector('[data-loop-close]');
    expect(routeOut.length).toBeGreaterThan(0);
    expect(close).not.toBeNull();
    expect(buttons.length).toBe(routeOut.length + 1);
  });

  it('falls back to the panel close control when a human-needed state has no decision metadata', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {} });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: [] }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-loop-close]'));
  });

  // §27.9/N5 — the ACTIONABLE §27 terminal gate: a view carrying appTurn (the step+turn identity) + declared
  // gateOptions + actionable renders clickable controls that route to the identity-carrying appGateDecision
  // and carry the step+turn identity onto the service (AC7). It is the ONLY shape that renders gate controls.
  const appGate = (over: Partial<FlowLoopView> = {}): FlowLoopView =>
    loop({ status: 'complete', actionable: true, gateOptions: ['approve'], appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, iteration: 2, verdict: 'clean', ...over });

  it('groups the gate-decision buttons in a labelled group so AT announces their purpose (WCAG 4.1.2)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {}, composeFeedback: () => {} });
    panel.render(appGate({ gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    const group = host.querySelector<HTMLElement>('.gatebar');
    expect(group?.getAttribute('role')).toBe('group');
    expect((group?.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
  });

  it('gives the abbreviated "changes" button an unabbreviated accessible name (WCAG 2.4.6 / 2.5.3)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {}, composeFeedback: () => {} });
    panel.render(appGate({ gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    const btn = host.querySelector<HTMLButtonElement>('[data-gate-option="request-changes"]')!;
    expect(btn.textContent).toBe('changes'); // visible label stays compact
    const name = btn.getAttribute('aria-label') ?? '';
    expect(name).toContain('changes'); // label-in-name (2.5.3): accessible name contains the visible text
    expect(name).toContain('request'); // …and is not the bare abbreviation
  });

  it('renders NO gate-decision buttons when the gate offers no options (mid-work / terminal)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {} });
    panel.render(appGate({ gateOptions: [] }), 'plan'); // an appTurn view but no options to offer
    expect(host.querySelector('[data-gate-option]')).toBeNull();
  });

  it('renders a §27 run-less def\'s gate options display-only: the read-only row, but NO decision buttons (AC 1)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {} });
    // A §27 run-less view: gate options present but not actionable, no round has run, no appTurn.
    panel.render(loop({ status: 'not-started', actionable: false, gateOptions: ['approve', 'request-changes'], iteration: undefined }), 'plan');
    expect(row('gate options')?.querySelector('.lv')?.textContent).toBe('approve · changes');
    expect(host.querySelector('[data-gate-option]')).toBeNull();
  });

  it('routes a §27 gate decision to appGateDecision with the step+turn identity (AC7/AC8)', () => {
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate(), 'plan');
    const btn = host.querySelector<HTMLButtonElement>('[data-gate-option="approve"]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(appGateDecision).toHaveBeenCalledTimes(1);
    expect(appGateDecision).toHaveBeenCalledWith('plan', 'consolidate-plan', 'approve');
  });

  it('routes a §27 request-changes to the feedback composer, not straight to appGateDecision (§27.9/AC4)', () => {
    // request-changes is a two-step interaction: clicking it OPENS the composer (curate + free text), and the
    // composer's submit is what carries the feedback on the decision. So the click fires composeFeedback with
    // the step+turn identity, and does NOT dispatch a decision yet.
    const appGateDecision = vi.fn();
    const composeFeedback = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision, composeFeedback });
    panel.render(appGate({ gateOptions: ['approve', 'request-changes'] }), 'plan');
    const rc = host.querySelector<HTMLButtonElement>('[data-gate-option="request-changes"]');
    expect(rc).not.toBeNull();
    rc!.click();
    expect(composeFeedback).toHaveBeenCalledTimes(1);
    expect(composeFeedback).toHaveBeenCalledWith('plan', 'consolidate-plan');
    expect(appGateDecision).not.toHaveBeenCalled(); // no decision dispatched until the composer submits
  });

  it('still dispatches approve directly (only request-changes detours through the composer)', () => {
    const appGateDecision = vi.fn();
    const composeFeedback = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision, composeFeedback });
    panel.render(appGate({ gateOptions: ['approve', 'request-changes'] }), 'plan');
    host.querySelector<HTMLButtonElement>('[data-gate-option="approve"]')!.click();
    expect(appGateDecision).toHaveBeenCalledWith('plan', 'consolidate-plan', 'approve');
    expect(composeFeedback).not.toHaveBeenCalled();
  });

  // §28.4.2 — back-to-red is a one-way control (no operator note): like approve/polish it dispatches STRAIGHT to
  // appGateDecision carrying the step+turn identity, with no composer detour. Its visible label reads "Back to RED".
  it('renders a §28.4.2 back-to-red control that dispatches straight to appGateDecision (one-way, no composer)', () => {
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate({ gateOptions: ['approve', 'back-to-red'], appTurn: { step: 'green', turnKey: 'consolidate-green' } }), 'green');
    const btn = host.querySelector<HTMLButtonElement>('[data-gate-option="back-to-red"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Back to RED'); // a readable label, not the raw kebab option
    btn!.click();
    expect(appGateDecision).toHaveBeenCalledTimes(1);
    expect(appGateDecision).toHaveBeenCalledWith('green', 'consolidate-green', 'back-to-red');
  });

  // §28.4.2 — with the back-to-red composer wired, Back to RED opens it (the brief rides its submit) instead of
  // dispatching straight to appGateDecision.
  it('opens the back-to-red composer when one is wired, carrying the step+turn identity', () => {
    const appGateDecision = vi.fn();
    const composeBackToRed = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision, composeBackToRed });
    panel.render(appGate({ gateOptions: ['approve', 'back-to-red'], appTurn: { step: 'green', turnKey: 'consolidate-green' } }), 'green');
    host.querySelector<HTMLButtonElement>('[data-gate-option="back-to-red"]')!.click();
    expect(composeBackToRed).toHaveBeenCalledWith('green', 'consolidate-green');
    expect(appGateDecision).not.toHaveBeenCalled();
  });

  it('renders NO §27 request-changes button when no composer is wired — it is a composer-only affordance (WCAG 4.1.2)', () => {
    // §27 request-changes MUST carry feedback (AC4); a note-less dispatch is dropped by the executor, so a
    // button wired only to appGateDecision would be inert. Without composeFeedback, render no request-changes
    // control at all (the same inert-affordance gate the whole gatebar uses), while approve still renders.
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate({ gateOptions: ['approve', 'request-changes'] }), 'plan');
    expect(host.querySelector('[data-gate-option="approve"]')).not.toBeNull();
    expect(host.querySelector('[data-gate-option="request-changes"]')).toBeNull();
  });

  it('routes a §27 redo to the redo composer, not straight to appGateDecision (§27.9/AC5)', () => {
    // redo, like request-changes, is a two-step interaction: clicking it OPENS the instruction composer, and the
    // composer's submit carries the instruction on the decision. So the click fires composeRedo with the identity,
    // and does NOT dispatch a decision yet.
    const appGateDecision = vi.fn();
    const composeRedo = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision, composeRedo });
    panel.render(appGate({ gateOptions: ['approve', 'redo'] }), 'plan');
    const redo = host.querySelector<HTMLButtonElement>('[data-gate-option="redo"]');
    expect(redo).not.toBeNull();
    redo!.click();
    expect(composeRedo).toHaveBeenCalledTimes(1);
    expect(composeRedo).toHaveBeenCalledWith('plan', 'consolidate-plan');
    expect(appGateDecision).not.toHaveBeenCalled(); // no decision dispatched until the composer submits
  });

  it('renders NO §27 redo button when no redo composer is wired — it is a composer-only affordance (WCAG 4.1.2)', () => {
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate({ gateOptions: ['approve', 'redo'] }), 'plan');
    expect(host.querySelector('[data-gate-option="approve"]')).not.toBeNull();
    expect(host.querySelector('[data-gate-option="redo"]')).toBeNull();
  });

  it('dispatches §27 polish directly to appGateDecision (one-way, no composer, no human input to lose)', () => {
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate({ gateOptions: ['approve', 'polish'] }), 'plan');
    host.querySelector<HTMLButtonElement>('[data-gate-option="polish"]')!.click();
    expect(appGateDecision).toHaveBeenCalledWith('plan', 'consolidate-plan', 'polish');
  });

  it('renders the polish stand-down view: a polish notice + approve (end polish) only (§27.9/AC6)', () => {
    // A polish view (the provider set polish:true and narrowed gateOptions to approve): the panel surfaces the
    // stand-down so the operator knows the orchestrator has released the keyboard, and approve ends it.
    const appGateDecision = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision });
    panel.render(appGate({ gateOptions: ['approve'], polish: true }), 'plan');
    expect(host.querySelector('[data-polish-standdown]')).not.toBeNull(); // the stand-down is surfaced
    expect(host.querySelector('[data-gate-option="approve"]')).not.toBeNull(); // approve ends it
    // no redo/request-changes/polish controls in the polish view (the provider withdrew them)
    expect(host.querySelector('[data-gate-option="redo"]')).toBeNull();
    expect(host.querySelector('[data-gate-option="request-changes"]')).toBeNull();
  });

  it('renders NO §27 gate buttons when appGateDecision is not injected (inert-affordance, WCAG 4.1.2)', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {} });
    panel.render(appGate(), 'plan');
    // The read-only gate-options row still shows, but with no decision service wired no clickable control renders.
    expect(row('gate options')).not.toBeUndefined();
    expect(host.querySelector('[data-gate-option]')).toBeNull();
  });

  it('omits the iteration row when no round has run (absent iteration is not "0", AC 1)', () => {
    createLoopPanel(host).render(loop({ status: 'not-started', actionable: false, gateOptions: ['approve'], iteration: undefined }), 'plan');
    expect(row('iteration')).toBeUndefined();
  });

  it('surfaces a def-failure reason with no iteration row and a route off the step (AC 6)', () => {
    createLoopPanel(host).render(loop({ status: 'error', errorReason: 'no §27 def named plan-loop in any tier', iteration: undefined }), 'plan');
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('no §27 def named plan-loop in any tier');
    expect(row('iteration')).toBeUndefined();
  });

  // §27.12c — a §27 work turn that stopped in `error` (no round has run, so `appTurn` carries the identity
  // and iteration is absent) offers all three route-out affordances: retry / accept-present-artifact /
  // terminate. Each carries the step+turn identity so the route-out acts on it, never ambient state (§6).
  const appRouteOutDeps = () => {
    const appRouteOut = vi.fn();
    return { deps: { githubRef: () => Promise.resolve(null), openExternal: () => {}, appRouteOut }, appRouteOut };
  };

  it('renders the three §27 route-out affordances on a §27 work-turn error (AC7)', () => {
    const { deps } = appRouteOutDeps();
    createLoopPanel(host, deps).render(
      loop({ status: 'error', errorReason: 'stalled: no terminal activity', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }),
      'plan',
    );
    expect(host.querySelector('[data-app-route-out="retry"]')).not.toBeNull();
    expect(host.querySelector('[data-app-route-out="accept"]')).not.toBeNull();
    expect(host.querySelector('[data-app-route-out="terminate"]')).not.toBeNull();
    expect(
      host.querySelector('[data-app-route-out="terminate"]')?.getAttribute('aria-label'),
    ).toBe('Terminate flow from the plan work turn');
  });

  it('each §27 route-out button fires the injected service with its step+turn identity (§6)', () => {
    const { deps, appRouteOut } = appRouteOutDeps();
    createLoopPanel(host, deps).render(
      loop({ status: 'error', errorReason: 'x', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }),
      'plan',
    );
    host.querySelector<HTMLElement>('[data-app-route-out="accept"]')!.click();
    expect(appRouteOut).toHaveBeenCalledWith('plan', 'work-plan', 'accept');
    host.querySelector<HTMLElement>('[data-app-route-out="terminate"]')!.click();
    expect(appRouteOut).toHaveBeenCalledWith('plan', 'work-plan', 'terminate');
  });

  it('shows NO route-out affordances while the §27 work turn is running (working)', () => {
    const { deps } = appRouteOutDeps();
    createLoopPanel(host, deps).render(
      loop({ status: 'working', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }),
      'plan',
    );
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('working');
    expect(host.querySelector('[data-app-route-out="retry"]')).toBeNull();
  });

  it('removes the §27 route-out group IN PLACE when a live turn recovers error → working (structuralSig omits status)', () => {
    // A §27 error and working view share one structural signature (structuralSig excludes loop.status and
    // keys only on iteration PRESENCE, absent for both), so a re-pull goes through patchInPlace →
    // syncAppRouteOut, exercising the in-place removal. If that regressed, stale retry/accept/terminate
    // controls would sit over a now-running turn and route-out against a live turn — the same in-place
    // removal the reason row gets when the status recovers from error.
    const { deps } = appRouteOutDeps();
    const panel = createLoopPanel(host, deps);
    panel.render(loop({ status: 'error', errorReason: 'stalled: no terminal activity', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(host.querySelector('[data-app-route-out]')).not.toBeNull();
    panel.render(loop({ status: 'working', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(host.querySelector('[data-app-route-out]')).toBeNull();
    expect(host.querySelector('[data-app-route-out-group]')).toBeNull();
  });

  it('removes the §27 route-out group IN PLACE when a live turn advances error → complete', () => {
    const { deps } = appRouteOutDeps();
    const panel = createLoopPanel(host, deps);
    panel.render(loop({ status: 'error', errorReason: 'x', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(host.querySelector('[data-app-route-out]')).not.toBeNull();
    panel.render(loop({ status: 'complete', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(host.querySelector('[data-app-route-out]')).toBeNull();
  });

  it('renders no route-out affordances when the service is not wired (inert-affordance guard, WCAG 4.1.2)', () => {
    createLoopPanel(host).render(
      loop({ status: 'error', errorReason: 'x', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }),
      'plan',
    );
    expect(host.querySelector('[data-app-route-out="retry"]')).toBeNull();
  });

  it('does not rebuild the DOM when re-rendered with unchanged content (no flicker on a no-op push)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    const closeBefore = host.querySelector('[data-loop-close]');
    panel.render(loop(), 'build'); // identical loop/title/refs — nothing the panel shows changed
    expect(host.querySelector('[data-loop-close]')).toBe(closeBefore); // same node ⇒ no replaceChildren
  });

  it('keeps keyboard focus in the panel across a no-op repaint', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    const close = host.querySelector<HTMLElement>('[data-loop-close]')!;
    close.focus();
    expect(document.activeElement).toBe(close);
    panel.render(loop(), 'build'); // unchanged ⇒ no rebuild
    expect(document.activeElement).toBe(close);
  });

  it('patches a status / iteration change in place without a rebuild, preserving focus (WCAG 2.4.3)', () => {
    // The live loop values tick on every background push during a run; patching them in place (like
    // the flow strip) keeps the DOM and focus attached instead of yanking focus to the close control.
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'impl-draft', iteration: 9 }), 'build');
    const close = host.querySelector<HTMLElement>('[data-loop-close]')!;
    close.focus();
    panel.render(loop({ status: 'awaiting-human-pr-approval', iteration: 10 }), 'build');
    expect(host.querySelector('[data-loop-close]')).toBe(close); // same node ⇒ no teardown
    expect(document.activeElement).toBe(close); // focus undisturbed
    expect(row('iteration')?.querySelector('.lv')?.textContent).toBe('10'); // value updated in place
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('awaiting-human-pr-approval');
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(true); // tone re-derived
  });

  it('clears the act tone in place when status returns to a working value (negative pair)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'awaiting-human-pr-approval' }), 'build');
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(true);
    panel.render(loop({ status: 'impl-draft' }), 'build'); // same structure ⇒ patched in place
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(false); // tone cleared
  });

  it('does not rewrite the live status/iteration text nodes on an unchanged patch (no content-free re-announce, WCAG 4.1.3)', () => {
    // patchInPlace runs on every passive push — a cost-only or refs-only update leaves status/iteration
    // untouched. Rewriting those text nodes inside the aria-live region with identical strings makes a
    // screen reader re-announce "status … / iteration …" with nothing changed. Assign only on a real change.
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'impl-draft', iteration: 9 }), 'build');
    const statusNode = row('status')!.querySelector('.lv')!.firstChild;
    const iterNode = row('iteration')!.querySelector('.lv')!.firstChild;
    panel.render(loop({ status: 'impl-draft', iteration: 9 }), 'build'); // identical values ⇒ patch path
    expect(row('status')!.querySelector('.lv')!.firstChild).toBe(statusNode);
    expect(row('iteration')!.querySelector('.lv')!.firstChild).toBe(iterNode);
  });

  it('does not re-fetch a ref while a fetch is already in flight, then retries once it resolves', async () => {
    let settle: (r: GithubRef | null) => void = () => {};
    const githubRef = vi.fn(() => new Promise<GithubRef | null>((res) => (settle = res)));
    const panel = createLoopPanel(host, { githubRef, openExternal: vi.fn() });
    panel.render(null, 'plan', { ticket: 25 });
    expect(githubRef).toHaveBeenCalledTimes(1);
    panel.render(null, 'plan', { ticket: 25 }); // same signature ⇒ patch path, but the fetch is pending
    expect(githubRef).toHaveBeenCalledTimes(1); // no overlapping re-fetch
    settle(null); // the in-flight fetch fails
    await flush();
    panel.render(null, 'plan', { ticket: 25 }); // no longer pending ⇒ a fresh retry fires
    expect(githubRef).toHaveBeenCalledTimes(2);
  });

  it('restores focus into the panel when a STRUCTURAL change forces a rebuild (WCAG 2.4.3)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ pr: null, branch: null }), 'build');
    host.querySelector<HTMLElement>('[data-loop-close]')!.focus();
    panel.render(loop({ pr: 179, branch: 'b' }), 'build'); // pr/branch rows appear ⇒ rebuild
    expect(host.contains(document.activeElement)).toBe(true); // never dropped to <body>
    expect(document.activeElement).toBe(host.querySelector('[data-loop-close]'));
  });

  it('does not steal focus from outside the panel on a rebuild', () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    const panel = createLoopPanel(host);
    panel.render(loop({ pr: null, branch: null }), 'build');
    outside.focus();
    expect(document.activeElement).toBe(outside);
    panel.render(loop({ pr: 179, branch: 'b' }), 'build'); // structural rebuild
    expect(document.activeElement).toBe(outside); // focus NOT pulled into the panel
    expect(host.contains(document.activeElement)).toBe(false);
  });

  it('retries an unresolved ref on a later push so a transient gh failure self-heals', async () => {
    let attempt = 0;
    const githubRef = vi.fn(async (): Promise<GithubRef | null> => {
      attempt += 1;
      return attempt === 1 ? null : { title: 'Persist flow inputs', body: 'b', url: 'https://github.com/o/r/issues/25' };
    });
    const panel = createLoopPanel(host, { githubRef, openExternal: vi.fn() });
    panel.render(null, 'plan', { ticket: 25 }); // manual step — constant structural signature
    await flush();
    expect(host.querySelector('a.reflink')).toBeNull(); // first fetch failed → bare number
    panel.render(null, 'plan', { ticket: 25 }); // same signature ⇒ patch path must re-attempt the fetch
    await flush();
    expect(host.querySelector('a.reflink')?.getAttribute('href')).toBe('https://github.com/o/r/issues/25');
  });

  it('flags an awaiting-human status as needs-you (the §22.3 act tone)', () => {
    createLoopPanel(host).render(loop({ status: 'awaiting-human-pr-approval' }), 'build');
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(true);
    createLoopPanel(host).render(loop({ status: 'awaiting-team-review' }), 'build');
    expect(row('status')?.querySelector('.lv')?.classList.contains('bad')).toBe(false);
  });

  it('renders the gate options row from the gate\'s human_options (request-changes → changes)', () => {
    createLoopPanel(host).render(loop({ gateOptions: ['approve', 'request-changes', 'impasse'] }), 'build');
    expect(row('gate options')?.querySelector('.lv')?.textContent).toBe('approve · changes · impasse');
  });

  it('omits the gate options row at a terminal / non-gate status (no options to offer)', () => {
    createLoopPanel(host).render(loop({ status: 'awaiting-team-review', ready: true }), 'build');
    expect(row('gate options')).toBeUndefined();
  });

  it('omits the pr / branch rows when the loop has no PR yet (plan phase)', () => {
    createLoopPanel(host).render(loop({ pr: null, branch: null }), 'plan');
    expect(row('status')).toBeTruthy();
    expect(row('iteration')).toBeTruthy();
    expect(row('pr')).toBeUndefined();
    expect(row('branch')).toBeUndefined();
  });

  it('clears the host when there is no loop state', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    panel.render(null, '');
    expect(host.childElementCount).toBe(0);
  });

  it('does not render the placeholder dev-note copy (no real data feeds it)', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(host.textContent).not.toContain('extensible');
  });

  it('dispose() leaves nothing behind: the host is emptied (UI-STANDARDS clean teardown)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop(), 'build');
    expect(host.childElementCount).toBeGreaterThan(0);
    panel.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('relocates unchanged: identical render in two different hosts (UI-STANDARDS organism rule)', () => {
    const a = document.createElement('aside');
    const b = document.createElement('aside');
    createLoopPanel(a).render(loop(), 'build');
    createLoopPanel(b).render(loop(), 'build');
    expect(a.innerHTML).toBe(b.innerHTML);
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument((h) => createLoopPanel(h).render(loop(), 'build'));
  });
});

// §27.6/AC5/AC8/AC9 — the §27 consolidator surface: the def's reviewer catalog with the chosen roster
// distinguished, the round verdict + reason, and the arm-interrupt control (offered only while iterating).
describe('docked loop panel — the §27 consolidator surface (AC5, AC8, AC9)', () => {
  const armDeps = () => {
    const armInterrupt = vi.fn();
    return { deps: { githubRef: () => Promise.resolve(null), openExternal: () => {}, armInterrupt }, armInterrupt };
  };
  const catalogNames = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-catalog-persona]')].map((el) => el.textContent ?? '');
  const chosenNames = (): string[] =>
    [...host.querySelectorAll<HTMLElement>('[data-catalog-persona]')].filter((el) => el.dataset.chosen === 'true').map((el) => el.textContent ?? '');

  it('renders the def reviewer catalog and distinguishes the chosen roster within it (AC8)', () => {
    const { deps } = armDeps();
    createLoopPanel(host, deps).render(
      loop({
        status: 'working',
        iteration: 2,
        appTurn: { step: 'plan', turnKey: 'review-plan' },
        catalog: ['review-plan-principal', 'review-plan-security', 'review-plan-contracts'],
        chosenRoster: ['review-plan-security'],
      }),
      'plan',
    );
    expect(catalogNames()).toEqual(['review-plan-principal', 'review-plan-security', 'review-plan-contracts']);
    expect(chosenNames()).toEqual(['review-plan-security']); // only the chosen persona is marked
  });

  it('shows the verdict and (for stop-for-a-human) its reason at the gate (AC5)', () => {
    createLoopPanel(host).render(
      loop({ status: 'complete', iteration: 2, appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, verdict: 'stop for a human', verdictReason: 'the reviewers disagree' }),
      'plan',
    );
    expect(row('verdict')?.querySelector('.lv')?.textContent).toBe('stop for a human');
    expect(row('verdict reason')?.querySelector('.lv')?.textContent).toBe('the reviewers disagree');
  });

  it('shows the verdict with no reason row on a non-stop verdict', () => {
    createLoopPanel(host).render(
      loop({ status: 'complete', iteration: 3, appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, verdict: 'another round' }),
      'plan',
    );
    expect(row('verdict')?.querySelector('.lv')?.textContent).toBe('another round');
    expect(row('verdict reason')).toBeUndefined();
  });

  it('offers the arm-interrupt control while iterating and fires it with the step identity (AC9, §6)', () => {
    const { deps, armInterrupt } = armDeps();
    createLoopPanel(host, deps).render(
      loop({ status: 'working', iteration: 2, appTurn: { step: 'plan', turnKey: 'review-plan' } }),
      'plan',
    );
    const btn = host.querySelector<HTMLElement>('[data-arm-interrupt]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(armInterrupt).toHaveBeenCalledWith('plan'); // the step identity it acts on, not ambient state
  });

  it('the arm-interrupt accessible name contains its visible label (WCAG 2.5.3 Label in Name)', () => {
    const { deps } = armDeps();
    createLoopPanel(host, deps).render(
      loop({ status: 'working', iteration: 2, appTurn: { step: 'plan', turnKey: 'review-plan' } }),
      'plan',
    );
    const btn = host.querySelector<HTMLElement>('[data-arm-interrupt]');
    expect(btn).not.toBeNull();
    const name = (btn!.getAttribute('aria-label') ?? '').toLowerCase();
    expect(name).toContain((btn!.textContent ?? '').toLowerCase()); // 2.5.3: accessible name contains the visible text
  });

  it('offers NO arm-interrupt control when not iterating — at the gate (complete) or in error (AC9)', () => {
    const { deps } = armDeps();
    const panel = createLoopPanel(host, deps);
    panel.render(loop({ status: 'complete', iteration: 2, appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, verdict: 'clean' }), 'plan');
    expect(host.querySelector('[data-arm-interrupt]')).toBeNull();
    panel.render(loop({ status: 'error', errorReason: 'x', iteration: 2, appTurn: { step: 'plan', turnKey: 'consolidate-plan' } }), 'plan');
    expect(host.querySelector('[data-arm-interrupt]')).toBeNull();
  });

  it('renders no arm-interrupt control when the service is not wired (inert-affordance guard, WCAG 4.1.2)', () => {
    createLoopPanel(host).render(loop({ status: 'working', iteration: 2, appTurn: { step: 'plan', turnKey: 'review-plan' } }), 'plan');
    expect(host.querySelector('[data-arm-interrupt]')).toBeNull();
  });
});

// §24.2.3 T7 — the popout also surfaces the ticket + PR the flow is working: the bare number renders
// immediately and a clickable GitHub link + title + truncated body fill in once `gh` resolves
// (best-effort). The refs section shows whenever the flow is active, even on a non-loop step.
describe('docked loop panel — ticket/PR refs (§24.2.3 T7)', () => {
  const ref = (over: Partial<GithubRef> = {}): GithubRef => ({
    title: 'Persist flow inputs',
    body: 'The flow drops the ticket on restart.',
    url: 'https://github.com/o/r/issues/25',
    ...over,
  });
  const refRow = (key: string): HTMLElement | undefined =>
    [...host.querySelectorAll<HTMLElement>('.refs .rrow')].find((r) => r.querySelector('.rk')?.textContent === key);

  it('renders the bare ticket + PR numbers immediately (before gh resolves)', () => {
    const githubRef = vi.fn(async () => null);
    createLoopPanel(host, { githubRef, openExternal: vi.fn() }).render(loop(), 'plan', { ticket: 25, pr: 29 });
    expect(refRow('Ticket')?.textContent).toContain('#25');
    expect(refRow('PR')?.textContent).toContain('#29');
  });

  it('fills in the title, a truncated body, and a working external link once gh resolves', async () => {
    const openExternal = vi.fn();
    const longBody = 'x'.repeat(500);
    const githubRef = vi.fn(async (kind: GithubRefKind) =>
      kind === 'issue' ? ref({ body: longBody, url: 'https://github.com/o/r/issues/25' }) : null,
    );
    createLoopPanel(host, { githubRef, openExternal }).render(loop({ pr: null, branch: null }), 'plan', { ticket: 25 });
    await flush();
    const ticket = refRow('Ticket')!;
    expect(ticket.querySelector('.rtitle')?.textContent).toBe('Persist flow inputs');
    const bodyText = ticket.querySelector('.rbody')?.textContent ?? '';
    expect(bodyText.length).toBeLessThan(longBody.length);
    expect(bodyText.endsWith('…')).toBe(true);
    const link = ticket.querySelector<HTMLAnchorElement>('a.reflink')!;
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/issues/25');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/issues/25');
  });

  it('renders a short body verbatim with no ellipsis (truncateBody pass-through branch)', async () => {
    const githubRef = vi.fn(async (kind: GithubRefKind) =>
      kind === 'issue' ? ref({ body: 'short body' }) : null,
    );
    createLoopPanel(host, { githubRef, openExternal: vi.fn() }).render(loop({ pr: null, branch: null }), 'plan', { ticket: 25 });
    await flush();
    const bodyText = refRow('Ticket')!.querySelector('.rbody')?.textContent ?? '';
    expect(bodyText).toBe('short body');
    expect(bodyText.endsWith('…')).toBe(false);
  });

  it('marks the refs section aria-live=polite so the async detail-fill is announced (WCAG 4.1.3)', () => {
    createLoopPanel(host, { githubRef: vi.fn(async () => null), openExternal: vi.fn() }).render(null, 'plan', { ticket: 25 });
    expect(host.querySelector('.refs')?.getAttribute('aria-live')).toBe('polite');
  });

  it('clears the in-flight guard on a rejected fetch so a later push retries', async () => {
    let n = 0;
    const githubRef = vi.fn(() => {
      n += 1;
      return n === 1
        ? Promise.reject(new Error('main gone'))
        : Promise.resolve<GithubRef>({ title: 't', body: 'b', url: 'https://github.com/o/r/issues/25' });
    });
    const panel = createLoopPanel(host, { githubRef, openExternal: vi.fn() });
    panel.render(null, 'plan', { ticket: 25 });
    await flush();
    expect(host.querySelector('a.reflink')).toBeNull(); // first fetch rejected → bare number, guard cleared
    panel.render(null, 'plan', { ticket: 25 }); // same signature ⇒ retry now that pending is clear
    await flush();
    expect(host.querySelector('a.reflink')?.getAttribute('href')).toBe('https://github.com/o/r/issues/25');
  });

  it('gives the external link a descriptive accessible name (WCAG 2.4.4 — link purpose in context)', async () => {
    const githubRef = vi.fn(async (kind: GithubRefKind) =>
      kind === 'issue' ? ref({ title: 'Persist flow inputs' }) : null,
    );
    createLoopPanel(host, { githubRef, openExternal: vi.fn() }).render(loop({ pr: null, branch: null }), 'plan', { ticket: 25 });
    await flush();
    const link = refRow('Ticket')!.querySelector<HTMLAnchorElement>('a.reflink')!;
    const name = link.getAttribute('aria-label') ?? '';
    expect(name).toContain('Ticket');
    expect(name).toContain('25');
    expect(name).toContain('Persist flow inputs');
  });

  it('renders no link for a non-GitHub url, keeping the bare number (sink allow-list, CWE-601)', async () => {
    const openExternal = vi.fn();
    const githubRef = vi.fn(async (kind: GithubRefKind) =>
      kind === 'issue' ? ref({ url: 'https://evil.com/phish' }) : null,
    );
    createLoopPanel(host, { githubRef, openExternal }).render(loop({ pr: null, branch: null }), 'plan', { ticket: 25 });
    await flush();
    expect(refRow('Ticket')?.querySelector('a.reflink')).toBeNull();
    expect(refRow('Ticket')?.querySelector('.rtitle')?.textContent).toBe('Persist flow inputs');
    expect(refRow('Ticket')?.textContent).toContain('#25');
  });

  it('opens the PR link with the PR url', async () => {
    const openExternal = vi.fn();
    const githubRef = vi.fn(async (kind: GithubRefKind) =>
      kind === 'pr' ? ref({ url: 'https://github.com/o/r/pull/29' }) : null,
    );
    createLoopPanel(host, { githubRef, openExternal }).render(loop(), 'build', { pr: 29 });
    await flush();
    host.querySelector<HTMLAnchorElement>('.refs .rrow a.reflink')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(openExternal).toHaveBeenCalledWith('https://github.com/o/r/pull/29');
  });

  it('renders refs on a NON-loop step (loop null) — the host is not cleared', () => {
    const githubRef = vi.fn(async () => null);
    createLoopPanel(host, { githubRef, openExternal: vi.fn() }).render(null, 'groom', { ticket: 25 });
    expect(refRow('Ticket')).toBeTruthy();
    expect(host.querySelector('.ldl')).toBeNull(); // no loop mirror on a non-loop step
  });

  it('clears the host only when BOTH loop and refs are absent', () => {
    const panel = createLoopPanel(host, { githubRef: vi.fn(async () => null), openExternal: vi.fn() });
    panel.render(loop(), 'build', { ticket: 25 });
    panel.render(null, '', undefined);
    expect(host.childElementCount).toBe(0);
  });

  it('degrades to a bare number with no link when gh resolves null', async () => {
    const githubRef = vi.fn(async () => null);
    createLoopPanel(host, { githubRef, openExternal: vi.fn() }).render(loop(), 'build', { ticket: 25 });
    await flush();
    expect(refRow('Ticket')?.textContent).toContain('#25');
    expect(refRow('Ticket')?.querySelector('a.reflink')).toBeNull();
  });
});

// The N8 sweep's split of this organism (§B.9): the surviving State section is relabelled off the retired
// file, the five repo-authored display sinks are stripped (CWE-117 / CWE-1007), the gate row is affirmative
// on both conjuncts (appTurn present AND appGateDecision injected), and focus routes to the surviving
// control. AC 3's behavior-preserving rule does not cover the labels an operator reads (AC 9).
describe('docked loop panel — the sweep split (§B.9)', () => {
  const BIDI = '‮'; // right-to-left override — a DISPLAY_UNSAFE byte that reorders an accessible name

  const appGate = (over: Partial<FlowLoopView> = {}): FlowLoopView =>
    loop({ status: 'complete', actionable: true, gateOptions: ['approve'], appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, iteration: 2, ...over });

  it('labels the surviving state section "State", naming the run state — not the retired file path (AC 9)', () => {
    createLoopPanel(host).render(loop(), 'build');
    const segH = host.querySelector<HTMLElement>('.lbody .seg-h');
    // positive: the section is still labelled (the .ldl live region's SC 1.3.1 heading survives)…
    expect(segH?.textContent).toBe('State');
    // …negative: and it no longer names the retired .agent-loop/state.yaml file.
    expect(host.textContent).not.toContain('.agent-loop/state.yaml');
  });

  it('strips a bidi override from the error reason on BOTH the create and the patch path (CWE-117)', () => {
    const panel = createLoopPanel(host);
    // create path — first render of an error view builds the reason row
    panel.render(loop({ status: 'error', errorReason: `no Claude${BIDI} at the prompt` }), 'build');
    expect(row('reason')?.querySelector('.lv')?.textContent).not.toContain(BIDI);
    // patch path — structuralSig excludes errorReason, so a changed reason patches the SAME node
    panel.render(loop({ status: 'error', errorReason: `still${BIDI} no Claude` }), 'build');
    expect(row('reason')?.querySelector('.lv')?.textContent).not.toContain(BIDI);
  });

  it('strips a bidi override from the verdict reason across create and patch (syncNamedRow, CWE-117)', () => {
    const panel = createLoopPanel(host);
    panel.render(appGate({ verdict: 'stop for a human', verdictReason: `they${BIDI} disagree` }), 'plan');
    expect(row('verdict reason')?.querySelector('.lv')?.textContent).not.toContain(BIDI);
    panel.render(appGate({ verdict: 'stop for a human', verdictReason: `still${BIDI} disagree` }), 'plan');
    expect(row('verdict reason')?.querySelector('.lv')?.textContent).not.toContain(BIDI);
  });

  it('strips a bidi override planted in a gate option: visible "changes", accessible name clean and still reading "request" (WCAG 2.5.3)', () => {
    const appGateDecision = vi.fn();
    const composeFeedback = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision, composeFeedback });
    panel.render(appGate({ gateOptions: ['approve', `request-changes${BIDI}`] }), 'plan');
    // the trailing override trims off, so the option still abbreviates to the compact visible label…
    const btn = [...host.querySelectorAll<HTMLButtonElement>('[data-gate-option]')].find((b) => b.textContent === 'changes');
    expect(btn).toBeDefined();
    const name = btn!.getAttribute('aria-label') ?? '';
    expect(name).not.toContain(BIDI); // …no override reaches the accessible name…
    expect(name).toContain('request'); // …which is still the unabbreviated form (label-in-name)
  });

  it('strips a bidi override from the step in the arm-interrupt aria-label, but dispatches the RAW step identity (§6, CWE-117)', () => {
    const armInterrupt = vi.fn();
    const step = `plan${BIDI}`;
    createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, armInterrupt }).render(
      loop({ status: 'working', iteration: 2, appTurn: { step, turnKey: 'review-plan' } }),
      'plan',
    );
    const btn = host.querySelector<HTMLElement>('[data-arm-interrupt]')!;
    expect(btn.getAttribute('aria-label')).not.toContain(BIDI); // the announced name is stripped…
    btn.click();
    expect(armInterrupt).toHaveBeenCalledWith(step); // …but the dispatched identity is the RAW planted id (§6)
  });

  it('strips a bidi override from the step in the route-out aria-labels, dispatching the RAW step (§6)', () => {
    const appRouteOut = vi.fn();
    const step = `plan${BIDI}`;
    createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appRouteOut }).render(
      loop({ status: 'error', errorReason: 'x', iteration: undefined, appTurn: { step, turnKey: 'work-plan' } }),
      'plan',
    );
    for (const el of host.querySelectorAll<HTMLElement>('[data-app-route-out]')) {
      expect(el.getAttribute('aria-label')).not.toContain(BIDI);
    }
    host.querySelector<HTMLElement>('[data-app-route-out="accept"]')!.click();
    expect(appRouteOut).toHaveBeenCalledWith(step, 'work-plan', 'accept');
  });

  it('renders NO gate buttons on a view carrying gateOptions but NO appTurn, even with appGateDecision wired (affirmative gate, WCAG 4.1.2)', () => {
    // The negation-collapse bug: dropping the appTurn conjunct would render buttons whose click reaches
    // appGateDecision(appTurn.step, …) with no turn identity — an inert control at a destructive gate.
    const appGateDecision = vi.fn();
    createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision }).render(
      loop({ status: 'awaiting-human-plan-approval', gateOptions: ['approve', 'request-changes'] }), // no appTurn
      'plan',
    );
    expect(row('gate options')).toBeDefined(); // the read-only preview still renders…
    expect(host.querySelector('[data-gate-option]')).toBeNull(); // …but no clickable control without a turn
  });

  it('focusDecision lands on the route-out on a §27 error view carrying a turn (the surviving control, WCAG 2.4.3)', () => {
    const appRouteOut = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appRouteOut });
    panel.render(loop({ status: 'error', errorReason: 'stalled', iteration: undefined, appTurn: { step: 'plan', turnKey: 'work-plan' } }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-app-route-out]')); // the first route-out button
  });
});

// §28.5.3/§28.8.3 — the changed-tests flag: when the machine detected a test-glob file changed since the RED
// baseline (a GREEN turn OR a refactor round), the panel surfaces a NON-blocking notice naming the files (for the
// regression-guard persona + human at the gate). Modeled on the polish-standdown notice — a role="status"
// live-region paragraph, present only when the view carries `changedTests`.
describe('docked loop panel — the changed-tests flag (§28.5.3)', () => {
  it('surfaces a notice naming the changed test files when the view carries the flag', () => {
    createLoopPanel(host).render(loop({ changedTests: ['tests/a.test.ts', 'tests/b.test.ts'] }), 'plan');
    const notice = host.querySelector('[data-changed-tests]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('role')).toBe('status'); // a live region so it is announced
    expect(notice?.textContent).toContain('tests/a.test.ts');
    expect(notice?.textContent).toContain('tests/b.test.ts');
  });

  it('phrases the notice phase-neutrally (§28.5.3 — the same flag is raised by GREEN and by a refactor round)', () => {
    // The flag is raised by the GREEN work turn AND by a refactor review round (§28.5.3); the notice text must
    // not hard-code one phase, or a refactor-round flag would read wrong. It still names the persona + the files.
    createLoopPanel(host).render(loop({ changedTests: ['tests/a.test.ts'] }), 'plan');
    const notice = host.querySelector('[data-changed-tests]');
    expect(notice?.textContent).not.toContain('during GREEN');
    expect(notice?.textContent).toContain('regression-guard'); // still routes to the persona
    expect(notice?.textContent).toContain('tests/a.test.ts'); // still names the files
  });

  it('omits the changed-tests notice when the view carries no flag', () => {
    createLoopPanel(host).render(loop({}), 'plan');
    expect(host.querySelector('[data-changed-tests]')).toBeNull();
  });

  it('drops the changed-tests notice on a re-render once the flag clears (structural transition)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ changedTests: ['tests/a.test.ts'] }), 'plan');
    expect(host.querySelector('[data-changed-tests]')).not.toBeNull();
    panel.render(loop({}), 'plan'); // the flag is gone → the notice must not linger
    expect(host.querySelector('[data-changed-tests]')).toBeNull();
  });
});

// §28.7 — the epic preview: at the gate, when the plan is classified an epic, the panel names every sub-ticket
// promotion will create, so the operator judges the split before approving (§27.10). Modeled on the catalog
// list — a section with one navigable node per sub-ticket (WCAG 1.3.1 — never a bare count).
describe('docked loop panel — the epic preview (§28.7)', () => {
  const EPIC = { subTickets: [{ index: 1, title: 'Wire the widget' }, { index: 2, title: 'Remove the widget' }] };

  it('names every sub-ticket when the view carries an epic split', () => {
    createLoopPanel(host).render(loop({ epic: EPIC }), 'plan');
    const section = host.querySelector('[data-epic-preview]');
    expect(section).not.toBeNull();
    expect(section?.getAttribute('role')).toBe('status'); // announced on appearance (WCAG 4.1.3)
    expect(section?.textContent).toContain('Epic — 2 sub-tickets'); // plural header
    const items = [...host.querySelectorAll<HTMLElement>('[data-epic-subticket]')].map((el) => el.textContent ?? '');
    expect(items).toHaveLength(2);
    expect(items.some((t) => t.includes('Wire the widget'))).toBe(true);
    expect(items.some((t) => t.includes('Remove the widget'))).toBe(true);
  });

  it('phrases the header singular for a one-sub-ticket epic', () => {
    createLoopPanel(host).render(loop({ epic: { subTickets: [{ index: 1, title: 'Only slice' }] } }), 'plan');
    expect(host.querySelector('[data-epic-preview]')?.textContent).toContain('Epic — 1 sub-ticket');
    expect(host.querySelector('[data-epic-preview]')?.textContent).not.toContain('1 sub-tickets');
  });

  it('associates the sub-ticket list with its "Epic" heading (WCAG 1.3.1 — not a bare "list, N items")', () => {
    createLoopPanel(host).render(loop({ epic: EPIC }), 'plan');
    const list = host.querySelector('[data-epic-preview] ul');
    const labelId = list?.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    const label = labelId ? host.querySelector(`#${labelId}`) : null;
    expect(label?.textContent).toContain('Epic');
  });

  it('strips display-unsafe bytes from a repo-sourced sub-ticket title (CWE-117)', () => {
    createLoopPanel(host).render(loop({ epic: { subTickets: [{ index: 1, title: 'Wire\u0007the\u0007widget' }] } }), 'plan');
    const item = host.querySelector('[data-epic-subticket]');
    expect(item?.textContent).not.toContain('\u0007');
    expect(item?.textContent).toContain('Wire');
    expect(item?.textContent).toContain('widget');
  });

  it('omits the epic preview when the view carries no epic split', () => {
    createLoopPanel(host).render(loop({}), 'plan');
    expect(host.querySelector('[data-epic-preview]')).toBeNull();
  });

  it('drops the epic preview on a re-render once the split clears (structural transition)', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ epic: EPIC }), 'plan');
    expect(host.querySelector('[data-epic-preview]')).not.toBeNull();
    panel.render(loop({}), 'plan');
    expect(host.querySelector('[data-epic-preview]')).toBeNull();
  });
});

// §27.9.1 N9b.5(e) — the status row's act tone reads `humanNeeded` when the view carries `autoGate`; a view with
// no `autoGate` keeps today's status-only tone (AC7).
describe('docked loop panel — the status tone under per-step gate authority (§27.9.1)', () => {
  const idle: FlowAutoGateView = { deciding: false, hung: false, haltReasons: [] };
  const statusIsAct = (): boolean | undefined => row('status')?.querySelector('.lv')?.classList.contains('bad');

  it('a halted gate (complete, humanNeeded, a halt reason) shows the act tone', () => {
    createLoopPanel(host).render(
      loop({ status: 'complete', humanNeeded: true, autoGate: { ...idle, haltReasons: [{ reason: 'stop-for-a-human' }] } }),
      'build',
    );
    expect(statusIsAct()).toBe(true);
  });

  it('a gate the engine is deciding (complete, not humanNeeded) shows no act tone (negative pair)', () => {
    createLoopPanel(host).render(loop({ status: 'complete', humanNeeded: false, autoGate: { ...idle, deciding: true } }), 'build');
    expect(statusIsAct()).toBe(false);
  });

  it('an accepted approve that hung (accepted, humanNeeded, hung) shows the act tone', () => {
    createLoopPanel(host).render(loop({ status: 'accepted', humanNeeded: true, autoGate: { ...idle, hung: true } }), 'build');
    expect(statusIsAct()).toBe(true);
  });

  it('a gate whose view carries no autoGate keeps today\'s settled tone even when humanNeeded (AC7 pin)', () => {
    createLoopPanel(host).render(loop({ status: 'complete', humanNeeded: true }), 'build');
    expect(statusIsAct()).toBe(false);
  });

  it('a deciding gate that halts on the same mounted panel shows the act tone', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'complete', humanNeeded: false, autoGate: { ...idle, deciding: true } }), 'build');
    panel.render(
      loop({ status: 'complete', humanNeeded: true, autoGate: { ...idle, haltReasons: [{ reason: 'stop-for-a-human' }] } }),
      'build',
    );
    expect(statusIsAct()).toBe(true);
  });

  it('an accepted approve that hangs on the same mounted panel shows the act tone', () => {
    const panel = createLoopPanel(host);
    panel.render(loop({ status: 'accepted', humanNeeded: false, autoGate: idle }), 'build');
    panel.render(loop({ status: 'accepted', humanNeeded: true, autoGate: { ...idle, hung: true } }), 'build');
    expect(statusIsAct()).toBe(true);
  });

  it('a halted gate the engine goes back to deciding on the same mounted panel drops the act tone (negative pair)', () => {
    const panel = createLoopPanel(host);
    panel.render(
      loop({ status: 'complete', humanNeeded: true, autoGate: { ...idle, haltReasons: [{ reason: 'stop-for-a-human' }] } }),
      'build',
    );
    panel.render(loop({ status: 'complete', humanNeeded: false, autoGate: { ...idle, deciding: true } }), 'build');
    expect(statusIsAct()).toBe(false);
  });
});

// §27.9.1 N9b.5(e) / N9b.6 — the S1 auto-gate elements the panel renders from `autoGate`.
describe('docked loop panel — the S1 auto-gate rows (§27.9.1)', () => {
  const idle: FlowAutoGateView = { deciding: false, hung: false, haltReasons: [] };
  const autoGateView = (autoGate: FlowAutoGateView, humanNeeded = true): FlowLoopView =>
    loop({ status: 'complete', actionable: true, gateOptions: ['approve', 'request-changes'], appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, iteration: 2, verdict: 'clean', humanNeeded, autoGate });
  const mount = () => createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {}, composeFeedback: () => {} });
  const reasonRows = (): string[] => [...host.querySelectorAll<HTMLElement>('[data-auto-halt-reason]')].map((r) => r.getAttribute('data-auto-halt-reason') ?? '');

  it('a gate the engine is deciding shows `[data-auto-deciding]` with the gate buttons still present', () => {
    mount().render(autoGateView({ ...idle, deciding: true }, false), 'plan');
    expect(host.querySelector('[data-auto-deciding]')).not.toBeNull();
    expect(host.querySelector('[data-gate-option="approve"]')).not.toBeNull();
  });

  it('a gate the engine is not deciding shows no `[data-auto-deciding]` (negative pair)', () => {
    mount().render(autoGateView(idle), 'plan');
    expect(host.querySelector('[data-auto-deciding]')).toBeNull();
  });

  it('an approve-outcome halt (l) shows its letter row with the refusal reason, beside the other letters (N9b.6)', () => {
    mount().render(autoGateView({ ...idle, haltReasons: [{ reason: 'c' }, { reason: 'l', detail: 'the run-state no longer matches the gate' }] }), 'plan');
    expect(reasonRows()).toEqual(['c', 'l']);
    expect(host.querySelector('[data-auto-halt-reason="l"]')?.textContent).toContain('the run-state no longer matches the gate');
  });

  it.each(['stop-for-a-human', 'c', 'e'] as const)('a halt on `%s` shows one labelled `[data-auto-halt-reason]` row for it', (reason) => {
    mount().render(autoGateView({ ...idle, haltReasons: [{ reason }] }), 'plan');
    const rows = [...host.querySelectorAll<HTMLElement>(`[data-auto-halt-reason="${reason}"]`)];
    expect(rows).toHaveLength(1);
    const label = autoHaltReasonLabel(reason);
    expect(label.trim()).not.toBe('');
    expect(rows[0].textContent).toContain(label);
  });

  it('the three reasons S1 renders carry three distinct shared labels', () => {
    expect(new Set((['stop-for-a-human', 'c', 'e'] as const).map(autoHaltReasonLabel)).size).toBe(3);
  });

  it('rebuilds the reason rows in place when the reason set changes on the same mounted panel', () => {
    const panel = mount();
    panel.render(autoGateView({ ...idle, haltReasons: [{ reason: 'c' }] }), 'plan');
    expect(reasonRows()).toEqual(['c']);
    panel.render(autoGateView({ ...idle, haltReasons: [{ reason: 'e' }] }), 'plan');
    expect(reasonRows()).toEqual(['e']);
  });

  it('a view with no halt reasons shows no `[data-auto-halt-reason]` row (negative pair)', () => {
    mount().render(autoGateView({ ...idle, deciding: true }, false), 'plan');
    expect(reasonRows()).toEqual([]);
  });
});

// §27.9.1 N9b.5(d) / N9b.6 — the S2 auto-gate elements: the (a), (b), (h), (i) rows with their detail, and the
// failed-effect marker (#137 S2).
describe('docked loop panel — the S2 auto-gate rows (§27.9.1)', () => {
  const idle: FlowAutoGateView = { deciding: false, hung: false, haltReasons: [] };
  const autoGateView = (autoGate: FlowAutoGateView): FlowLoopView =>
    loop({ status: 'complete', actionable: true, gateOptions: ['approve', 'request-changes'], appTurn: { step: 'plan', turnKey: 'consolidate-plan' }, iteration: 2, verdict: 'clean', humanNeeded: true, autoGate });
  const mount = () => createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, appGateDecision: () => {}, composeFeedback: () => {} });
  const marker = (): HTMLElement | null => host.querySelector<HTMLElement>('[data-failed-effect]');

  it.each(['a', 'b', 'h', 'i'] as const)('a halt on `%s` shows one labelled `[data-auto-halt-reason]` row carrying its detail', (reason) => {
    mount().render(autoGateView({ ...idle, haltReasons: [{ reason, detail: 'the engine saw this' }] }), 'plan');
    const rows = [...host.querySelectorAll<HTMLElement>(`[data-auto-halt-reason="${reason}"]`)];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain(autoHaltReasonLabel(reason));
    expect(rows[0].textContent).toContain('the engine saw this');
  });

  it('a halt naming every S2 letter at once shows one row per letter', () => {
    mount().render(autoGateView({ ...idle, haltReasons: (['a', 'b', 'h', 'i'] as const).map((reason) => ({ reason })) }), 'plan');
    expect([...host.querySelectorAll<HTMLElement>('[data-auto-halt-reason]')].map((r) => r.getAttribute('data-auto-halt-reason'))).toEqual(['a', 'b', 'h', 'i']);
  });

  it.each(['set', 'unknown'] as const)('a `%s` failed-effect marker shows `[data-failed-effect]` with its state and failure text, beside the gate buttons', (state) => {
    mount().render(autoGateView({ ...idle, failedEffect: { state, detail: 'gh update-issue-body exited 1' } }), 'plan');
    const el = marker();
    expect(el).not.toBeNull();
    expect(el!.getAttribute('data-failed-effect')).toBe(state);
    expect(el!.textContent).toContain('gh update-issue-body exited 1');
    expect(host.querySelector('[data-gate-option="approve"]')).not.toBeNull();
  });

  it('a view with no failed-effect marker shows no `[data-failed-effect]` (negative pair)', () => {
    mount().render(autoGateView(idle), 'plan');
    expect(marker()).toBeNull();
  });

  it('the marker appears and goes away in place on the same mounted panel as the view changes', () => {
    const panel = mount();
    panel.render(autoGateView(idle), 'plan');
    expect(marker()).toBeNull();
    panel.render(autoGateView({ ...idle, failedEffect: { state: 'set', detail: 'first failure' } }), 'plan');
    expect(marker()).not.toBeNull();
    expect(marker()!.textContent).toContain('first failure');
    panel.render(autoGateView({ ...idle, failedEffect: { state: 'unknown', detail: 'second failure' } }), 'plan');
    expect(marker()?.getAttribute('data-failed-effect')).toBe('unknown');
    expect(marker()?.textContent).toContain('second failure');
    panel.render(autoGateView(idle), 'plan');
    expect(marker()).toBeNull();
  });

  it('a halt detail and a marker detail carrying markup and control characters render as literal, stripped text (CWE-79)', () => {
    const hostile = '<img src=x onerror=alert(1)>\u001b[31m';
    mount().render(autoGateView({ ...idle, haltReasons: [{ reason: 'b', detail: hostile }], failedEffect: { state: 'set', detail: hostile } }), 'plan');
    expect(host.querySelector('img')).toBeNull();
    const row = host.querySelector<HTMLElement>('[data-auto-halt-reason="b"]')!;
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(row.textContent).not.toContain('\u001b');
    expect(marker()).not.toBeNull();
    expect(marker()!.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(marker()!.textContent).not.toContain('\u001b');
  });
});
