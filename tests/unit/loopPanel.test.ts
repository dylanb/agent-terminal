// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopPanel } from '../../src/renderer/src/loopPanel';
import { assertRendersFromHostDocument } from './relocatable';
import type { FlowLoopView, GithubRef, GithubRefKind } from '../../src/shared/ipc';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// §24.2.3 T2 — the docked loop panel organism (UI-STANDARDS §1.2): the EXPANDED read-only state
// mirror that the rail's compact Loop read-out opens. It renders the real v4 `state.yaml` vocabulary
// (status / iteration / pr / branch) at 100% fidelity to design/shell/loop-flow.html's State section.
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
  it('renders the v4 state mirror rows from the loop view', () => {
    createLoopPanel(host).render(loop(), 'build');
    expect(row('status')?.querySelector('.lv')?.textContent).toBe('awaiting-human-pr-approval');
    expect(row('iteration')?.querySelector('.lv')?.textContent).toBe('9');
    expect(row('pr')?.querySelector('.lv')?.textContent).toBe('#179');
    expect(row('branch')?.querySelector('.lv')?.textContent).toBe('agent-loop/issue-176');
  });

  it('shows the D48 error reason so a stopped loop says WHY, not a bare "error" (§26.3)', () => {
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

  it('renders a "mark turn complete" control on a loop step that invokes the injected service (§26.3/D47a c)', () => {
    const markTurnComplete = vi.fn();
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      markTurnComplete,
    });
    panel.render(loop({ status: 'plan-draft' }), 'plan');
    const btn = host.querySelector<HTMLButtonElement>('[data-loop-mark-complete]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(markTurnComplete).toHaveBeenCalledTimes(1);
  });

  it('renders a "Retry" control on an errored loop that invokes the injected retry service (§26.3/D48)', () => {
    const retryTurn = vi.fn();
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      retryTurn,
    });
    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'plan');
    const btn = host.querySelector<HTMLButtonElement>('[data-loop-retry]');
    expect(btn).not.toBeNull();
    btn!.click();
    expect(retryTurn).toHaveBeenCalledTimes(1);
  });

  // WCAG 2.1 SC 4.1.3 (Status Messages). Assistive tech does not announce content that already exists when
  // a live region is registered. Rebuilding `.ldl` to enter `error` therefore produces SILENCE at exactly
  // the moment the turn failed. The region must survive, so the reason row is announced as an addition.
  it('keeps the live region alive when the loop enters error, and adds the reason + Retry into it', () => {
    const retryTurn = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, retryTurn });

    panel.render(loop({ status: 'impl-draft' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;
    expect(host.querySelector('[data-loop-retry]')).toBeNull();

    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore); // same live region → the addition is announced
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('no Claude at the prompt');
    expect(host.querySelector('[data-loop-retry]')).not.toBeNull();
  });

  it('removes the reason row and the Retry control when the loop recovers out of error', () => {
    const retryTurn = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, retryTurn });

    panel.render(loop({ status: 'error', errorReason: 'no Claude at the prompt' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;

    panel.render(loop({ status: 'impl-draft' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore);
    expect(row('reason')).toBeUndefined();
    expect(host.querySelector('[data-loop-retry]')).toBeNull();
  });

  it('updates a changed reason without replacing the live region', () => {
    const retryTurn = vi.fn();
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, retryTurn });

    panel.render(loop({ status: 'error', errorReason: 'first reason' }), 'impl');
    const ldlBefore = host.querySelector('.ldl')!;

    panel.render(loop({ status: 'error', errorReason: 'second reason' }), 'impl');

    expect(host.querySelector('.ldl')).toBe(ldlBefore);
    expect(row('reason')?.querySelector('.lv')?.textContent).toBe('second reason');
  });

  it('renders NO Retry control when the loop is not in error (recovery is error-only, WCAG 4.1.2)', () => {
    const retryTurn = vi.fn();
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      retryTurn,
    });
    panel.render(loop({ status: 'plan-draft' }), 'plan');
    expect(host.querySelector('[data-loop-retry]')).toBeNull();
  });

  it('renders a gate-decision button per gate option that invokes the injected service (§26.6 / L5)', () => {
    const gateDecision = vi.fn();
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      gateDecision,
    });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[data-gate-option]')];
    expect(buttons.map((b) => b.dataset.gateOption)).toEqual(['approve', 'request-changes', 'impasse']);
    buttons.find((b) => b.dataset.gateOption === 'request-changes')!.click();
    expect(gateDecision).toHaveBeenCalledTimes(1);
    expect(gateDecision).toHaveBeenCalledWith('request-changes');
  });

  it('focuses its own gate decision on request, so the shell need not know the gate markup (WCAG 2.4.3)', () => {
    // The alert routes the human ONTO the decision; the panel owns which control that is, rather than a
    // sibling reaching into its DOM for [data-gate-option] (UI-STANDARDS §2.2 rule 4).
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, gateDecision: () => {} });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-gate-option="approve"]'));
  });

  it('falls back to the recovery action when the human-needed state is an error, not a gate (WCAG 2.4.3)', () => {
    // `error` is human-needed but shows a Retry control, not gate options. The blocked human must still
    // land on the panel's actionable control, not be left on the alert button.
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {}, retryTurn: () => {} });
    panel.render(loop({ status: 'error' }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-loop-retry]'));
  });

  it('falls back to the panel close control when a human-needed state has no decision metadata', () => {
    const panel = createLoopPanel(host, { githubRef: () => Promise.resolve(null), openExternal: () => {} });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: [] }), 'plan');
    expect(panel.focusDecision()).toBe(true);
    expect(document.activeElement).toBe(host.querySelector('[data-loop-close]'));
  });

  it('groups the gate-decision buttons in a labelled group so AT announces their purpose (WCAG 4.1.2)', () => {
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      gateDecision: () => {},
    });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    const group = host.querySelector<HTMLElement>('.gatebar');
    expect(group?.getAttribute('role')).toBe('group');
    expect((group?.getAttribute('aria-label') ?? '').length).toBeGreaterThan(0);
  });

  it('gives the abbreviated "changes" button an unabbreviated accessible name (WCAG 2.4.6 / 2.5.3)', () => {
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      gateDecision: () => {},
    });
    panel.render(loop({ status: 'awaiting-human-plan-approval', gateOptions: ['approve', 'request-changes', 'impasse'] }), 'plan');
    const btn = host.querySelector<HTMLButtonElement>('[data-gate-option="request-changes"]')!;
    expect(btn.textContent).toBe('changes'); // visible label stays compact
    const name = btn.getAttribute('aria-label') ?? '';
    expect(name).toContain('changes'); // label-in-name (2.5.3): accessible name contains the visible text
    expect(name).toContain('request'); // …and is not the bare abbreviation
  });

  it('omits the "mark turn complete" control when no markTurnComplete service is injected (inert-affordance, WCAG 4.1.2)', () => {
    // The control does nothing without deps.markTurnComplete; rendering an operable-looking button that
    // is inert on activation misleads every user, AT included. Gate it on the service like the gate bar.
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
    });
    panel.render(loop({ status: 'plan-draft' }), 'plan');
    expect(host.querySelector('[data-loop-mark-complete]')).toBeNull();
  });

  it('renders NO gate-decision buttons when the gate offers no options (mid-work / terminal)', () => {
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      gateDecision: () => {},
    });
    panel.render(loop({ status: 'plan-draft' }), 'plan'); // no gateOptions
    expect(host.querySelector('[data-gate-option]')).toBeNull();
  });

  it('renders a §27 run-less def\'s gate options display-only: the read-only row, but NO decision buttons (AC 1)', () => {
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      gateDecision: () => {},
    });
    // A §27 run-less view: gate options present but not actionable, no round has run.
    panel.render(loop({ status: 'not-started', actionable: false, gateOptions: ['approve', 'request-changes'], iteration: undefined }), 'plan');
    expect(row('gate options')?.querySelector('.lv')?.textContent).toBe('approve · changes');
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

  it('renders NO Retry on a run-less §27 failure (no turn to re-drive), but does on a §26 turn error (WCAG 4.1.2)', () => {
    const deps = { githubRef: () => Promise.resolve(null), openExternal: () => {}, retryTurn: () => {} };
    // §27 resolution failure: error and retryTurn wired, but no round has run — Retry (re-drive the
    // turn) is inert here, so only the iteration guard keeps it from rendering an inert affordance.
    createLoopPanel(host, deps).render(loop({ status: 'error', errorReason: 'no §27 def named plan-loop', iteration: undefined }), 'plan');
    expect(host.querySelector('[data-loop-retry]')).toBeNull();
    // §26 turn error: a round ran, so re-driving it is meaningful — Retry renders.
    document.body.innerHTML = '<aside id="loop-panel"></aside>';
    const host2 = document.getElementById('loop-panel')!;
    createLoopPanel(host2, deps).render(loop({ status: 'error', errorReason: 'no Claude at the prompt', iteration: 3 }), 'plan');
    expect(host2.querySelector('[data-loop-retry]')).not.toBeNull();
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
    // The §26 turn-error Retry is NOT rendered for a §27 error (no iteration): the §27 route-out replaces it.
    expect(host.querySelector('[data-loop-retry]')).toBeNull();
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
    // keys only on iteration PRESENCE, absent for both), so a Retry re-pull goes through patchInPlace →
    // syncAppRouteOut, exercising the in-place removal. If that regressed, stale retry/accept/terminate
    // controls would sit over a now-running turn and route-out against a live turn. Mirrors §26's
    // "removes the reason row in place when the status recovers from error".
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

  it('shows no "mark turn complete" control when there is no loop step (refs-only panel)', () => {
    const panel = createLoopPanel(host, {
      githubRef: () => Promise.resolve(null),
      openExternal: () => {},
      markTurnComplete: () => {},
    });
    panel.render(null, 'plan', { ticket: 176 }); // ticket/PR popout, no loop mirror
    expect(host.querySelector('[data-loop-mark-complete]')).toBeNull();
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
