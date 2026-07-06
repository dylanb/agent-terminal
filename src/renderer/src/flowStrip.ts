// Flow status strip (§22.3 / §24.2.2) — a placement-agnostic organism (UI-STANDARDS §1.2)
// rendering with 100% fidelity to the §24.1 mockup (design/shell/converged.html). A load failure
// has no mockup counterpart; by decision it renders as a single `--danger` text line, no station,
// no control (§18.1). It follows the terminal's cwd, mirroring the repo-scoped todo list (§16.3):
// before a repo key is known it renders nothing.

import type { FlowApi, FlowStateView, FlowStatus, FlowLoopView, FlowPrompt, FlowRefs } from '../../shared/ipc';
import { hasFlowRefs } from '../../shared/ipc';
import { FLOW_CHANGED_EVENT } from './paneActions';
import { spillTone, toneLabel } from './loopStatus';

type StationState = 'todo' | 'active' | 'done';
type Act = 'start' | 'advance' | 'restart' | 'undo';

/** The control per status; null = no control (load failure). The Start control reappears
 *  in `done` relabeled "Restart" — re-running the step (§24.2.2). */
const CONTROL: Record<FlowStatus, { label: string; act: Act } | null> = {
  not_started: { label: 'Start', act: 'start' },
  in_progress: { label: 'Advance', act: 'advance' },
  done: { label: 'Restart', act: 'restart' },
  error: null,
};

/** The rail brackets the real steps with two synthetic stations: "Not started" (active before the
 *  flow starts) and "Completed" (active once it finishes), so the rail reads [Not started] · step₁ ·
 *  … · stepₙ · [Completed] (§24.2.3 T1 generalized the bookends across N real steps). */
function railStations(state: FlowStateView): Array<{ name: string; st: StationState }> {
  const status = state.status as Exclude<FlowStatus, 'error'>;
  const currentIndex = state.position - 1;
  const notStarted: StationState = status === 'not_started' ? 'active' : 'done';
  const steps: Array<{ name: string; st: StationState }> = state.steps.map((name, i) => {
    const st: StationState =
      status === 'not_started'
        ? 'todo'
        : status === 'done'
          ? 'done'
          : i < currentIndex
            ? 'done'
            : i === currentIndex
              ? 'active'
              : 'todo';
    return { name, st };
  });
  const completed: StationState = status === 'done' ? 'active' : 'todo';
  return [{ name: 'Not started', st: notStarted }, ...steps, { name: 'Completed', st: completed }];
}

export interface FlowStrip {
  /** (Re)pull the current repo's flow state and repaint (no-op until a repo key is known). */
  refresh(): Promise<void>;
  /** The terminal's repo changed (cd across a key boundary, §16.3): re-scope and re-pull. */
  onRepoChanged(repoKey: string | null): void;
  /** Focus the loop read-out if one is shown, returning whether it did (so the root can fall back),
   *  so the root needn't reach into the strip's markup (WCAG 2.4.3). */
  focusLoopReadout(): boolean;
  /** Tear down: unsubscribe the flow:onStateChanged push and clear the host (UI-STANDARDS clean teardown). */
  dispose(): void;
}

/** The strip's deps: the flow IPC seam plus an optional hand-off of the current loop mirror to the
 *  composition root (§24.2.3 T2) — it routes the data to the sibling docked panel without the strip
 *  reaching across organisms. Fired on every render: `null` when the step has no loop mirror.
 *  `onRevealLoop` is omitted: the OS-notification reveal (§24.2.3 T4) is wired at the composition root
 *  on window.flow, not through the strip (interface segregation — the strip never reveals). So is
 *  `markTurnComplete` (§26.3/D47a c) and `retryTurn` (§26.3/D48): the loop panel owns those controls,
 *  not the strip. */
export type FlowStripDeps = Omit<
  FlowApi,
  | 'onRevealLoop'
  | 'onBootstrapError'
  | 'onBootstrapConflict'
  | 'resolveBootstrapConflict'
  | 'githubRef'
  | 'openExternal'
  | 'markTurnComplete'
  | 'gateDecision'
  | 'retryTurn'
> & {
  /** The docked loop panel's element id, injected by the composition root so the read-out's
   *  `aria-controls` is instance-scoped — the organism never bakes in a document-level id
   *  (UI-STANDARDS §2.2 rule 1). Omitted → no aria-controls (aria-expanded still conveys state). */
  loopPanelId?: string;
  onPanelState?: (loop: FlowLoopView | null, title: string, refs?: FlowRefs) => void;
  /** Hand a step-entry input prompt (§24.2.3 T3) to the composition root, which opens its modal
   *  organism. `submit` records the typed values (provideInput) and re-renders. `null` closes the
   *  modal (no prompt on this view). The strip never reaches across to the modal directly. */
  onPrompt?: (prompt: FlowPrompt | null, stepName: string, submit: (values: Record<string, string>) => void) => void;
  /** Open the destructive Terminate confirmation (#26 AC3/AC4). The composition root surfaces the
   *  repo's current todo count and gates the IPC call; it invokes `confirm` only when the user
   *  confirms. The strip's `confirm` closure then drives `terminate(repoKey)` and repaints. Omitted →
   *  no Terminate control is rendered (the strip never reaches across to the dialog directly). */
  onTerminate?: (repoKey: string, confirm: () => void) => void;
};

function header(doc: Document, text: string): HTMLElement {
  const sect = doc.createElement('div');
  sect.className = 'sect';
  sect.textContent = text;
  return sect;
}

/** The live-derived status line text, or null when this view shows no derived line (§24.2.2 S5):
 *  it appears only on an in_progress step that has derived counts and is not a loop step. */
function derivedText(state: FlowStateView): string | null {
  if (state.status === 'in_progress' && state.derived && !state.loop) {
    const d = state.derived;
    return `${d.todosDone} / ${d.todosTotal} done · ${d.activity}`;
  }
  return null;
}

/** A signature of everything that fixes the strip's DOM STRUCTURE — deliberately NOT the live values
 *  a passive push patches in place (loop iteration/tone, derived counts/activity). Two views with an
 *  equal signature differ only in those live values, so the existing nodes can be updated without a
 *  teardown — and a teardown is exactly what detaches a focused control, an in-flight click target,
 *  or a confirm dialog's captured opener (§24.2.2 S5). */
function structuralSig(state: FlowStateView): string {
  return JSON.stringify([
    state.status,
    state.status === 'error' ? state.error ?? '' : '',
    state.steps,
    state.position,
    !!state.loop,
    // The §26.10 cost node's PRESENCE (not its value) is structural: it appears once a cost is recorded,
    // so a first-cost push forces a full render; thereafter value-only changes patch in place.
    state.loop ? state.loop.cost !== undefined : false,
    // The refs read-out (§24.2.3 T7) renders the actual numbers with no patch handler, so any refs
    // change must force a full render rather than a value-only patch.
    state.refs ?? null,
    derivedText(state) !== null,
    state.notice ?? '',
  ]);
}

/** The compact read-only loop read-out (§24.2.3 T2) shown in the rail: a 3-tone status pill (the
 *  one-word tone, not the unbounded status) + the iteration, framed as a `role=button` that opens
 *  the docked panel (the shell wires the click). The exact v4 vocabulary lives in that panel. */
function loopReadout(doc: Document, loop: FlowLoopView, controlsId?: string): HTMLElement {
  const stat = doc.createElement('span');
  stat.className = 'stat loopstat';
  stat.setAttribute('role', 'button');
  stat.tabIndex = 0;
  stat.setAttribute('aria-expanded', 'false');
  if (controlsId) stat.setAttribute('aria-controls', controlsId); // instance-scoped; never a baked-in id

  const k = doc.createElement('span');
  k.className = 'k';
  k.textContent = 'Loop';

  const v = doc.createElement('span');
  v.className = 'v';
  const pill = doc.createElement('span');
  pill.className = `spill ${spillTone(loop.status)}`;
  const dot = doc.createElement('span');
  dot.className = 'pdot';
  const label = doc.createElement('span');
  label.textContent = toneLabel(loop.status);
  pill.append(dot, label);
  const iter = doc.createElement('span');
  iter.className = 'mono loop-iter';
  iter.textContent = `iter ${loop.iteration}`;
  const car = doc.createElement('span');
  car.className = 'car';
  car.setAttribute('aria-hidden', 'true');
  car.textContent = '▸';
  v.append(pill, iter);
  // §26.10 — the display-only cost readout, present once an iteration boundary has recorded a cost.
  if (loop.cost !== undefined) {
    const cost = doc.createElement('span');
    cost.className = 'mono loop-cost';
    cost.textContent = loop.cost;
    v.append(cost);
  }
  v.append(car);

  stat.append(k, v);
  return stat;
}

/** The compact read-out shown on a non-loop step that still has a ticket/PR (§24.2.3 T7): a
 *  `loopstat`-classed `role=button` (so the shell's existing open wiring + aria apply) summarising the
 *  numbers. The full ticket/PR detail lives in the docked panel it opens. */
function refsReadout(doc: Document, refs: FlowRefs, controlsId?: string): HTMLElement {
  const stat = doc.createElement('span');
  stat.className = 'stat loopstat';
  stat.setAttribute('role', 'button');
  stat.tabIndex = 0;
  stat.setAttribute('aria-expanded', 'false');
  if (controlsId) stat.setAttribute('aria-controls', controlsId);

  const k = doc.createElement('span');
  k.className = 'k';
  k.textContent = 'Flow';

  const v = doc.createElement('span');
  v.className = 'v';
  const parts: string[] = [];
  if (refs.ticket !== undefined) parts.push(`#${refs.ticket}`);
  if (refs.pr !== undefined) parts.push(`PR #${refs.pr}`);
  const summary = doc.createElement('span');
  summary.className = 'mono';
  summary.textContent = parts.join(' · ');
  const car = doc.createElement('span');
  car.className = 'car';
  car.setAttribute('aria-hidden', 'true');
  car.textContent = '▸';
  v.append(summary, car);

  stat.append(k, v);
  return stat;
}

export function createFlowStrip(host: HTMLElement, deps: FlowStripDeps): FlowStrip {
  const doc = host.ownerDocument; // build from the host's document so the strip relocates (UI §2.2.1)
  let repoKey: string | null = null;
  // The structure last painted; a passive push whose structure matches patches in place (§24.2.2 S5).
  let lastSig: string | null = null;

  const runAct = (act: Act, key: string): Promise<FlowStateView> =>
    act === 'start'
      ? deps.start(key)
      : act === 'advance'
        ? deps.advance(key)
        : act === 'restart'
          ? deps.restart(key)
          : deps.undo(key);

  /** A lifecycle control button: fires its transition, disabling itself while in flight so a
   *  double-click can't fire it twice (the machine would reject the second anyway — §24.2.2 — but
   *  this keeps the UI honest), then re-renders from the returned state. */
  function controlButton(label: string, act: Act): HTMLButtonElement {
    const button = doc.createElement('button');
    button.className = `flow-${act === 'undo' ? 'undo' : 'control'} pill`;
    button.textContent = label;
    button.addEventListener('click', () => {
      if (repoKey === null) return;
      const key = repoKey;
      button.disabled = true;
      runAct(act, key)
        .then((view) => {
          // The cwd may have moved while the transition was in flight; the awaited view belongs to
          // `key`, so drop it rather than repaint the now-current repo (mirrors emitPrompt).
          if (repoKey !== key) return;
          applyTransition(view);
          // Signal the todo overlay to re-pull: its template picker is gated to the active step,
          // which this transition may have changed (decoupled contract, §4.1/§9.1).
          window.dispatchEvent(new CustomEvent(FLOW_CHANGED_EVENT));
        })
        .catch(() => void refresh())
        // Re-enable so retry is possible if both the action and refresh()'s state() reject (no
        // repaint detached this button). Harmless on success: the repaint already replaced it.
        .finally(() => {
          button.disabled = false;
        });
    });
    return button;
  }

  function terminateButton(): HTMLButtonElement {
    const button = doc.createElement('button');
    button.className = 'flow-terminate pill';
    button.textContent = 'Terminate';
    button.addEventListener('click', () => {
      if (repoKey === null) return;
      const key = repoKey;
      deps.onTerminate?.(key, () => {
        if (repoKey !== key) return;
        button.disabled = true;
        deps
          .terminate(key)
          .then((view) => {
            if (repoKey !== key) return;
            applyTransition(view);
            window.dispatchEvent(new CustomEvent(FLOW_CHANGED_EVENT));
          })
          .catch(() => void refresh())
          .finally(() => {
            button.disabled = false;
          });
      });
    });
    return button;
  }

  function render(state: FlowStateView): void {
    lastSig = structuralSig(state); // this paint defines the structure a later passive push compares to
    // Carry focus across the rebuild if the keyboard user was on the Loop read-out, rather than
    // dropping it to <body> (WCAG 2.4.3).
    const keepLoopFocus = doc.activeElement instanceof HTMLElement && doc.activeElement.classList.contains('loopstat') && host.contains(doc.activeElement);
    host.replaceChildren();

    if (state.status === 'error') {
      host.append(header(doc, 'Flow'));
      const err = doc.createElement('div');
      err.className = 'flow-error';
      err.textContent = state.error ?? 'flow failed to load';
      host.append(err);
      deps.onPanelState?.(null, ''); // no step → the docked panel clears + closes
      return;
    }

    // The header position counts the synthetic bookends too (e.g. 1/3 → 3/3 for one real step).
    const railStn = railStations(state);
    const activeIndex = railStn.findIndex((s) => s.st === 'active');
    host.append(header(doc, `Flow — step ${activeIndex + 1} / ${railStn.length}`));

    // The station rail, 100%-fidelity to the §24.1 mockup (design/shell/converged.html).
    const rail = doc.createElement('div');
    rail.className = 'flow vert';
    railStn.forEach((s, i) => {
      const stn = doc.createElement('span');
      stn.className = `stn ${s.st}`;
      const dot = doc.createElement('span');
      dot.className = 'o';
      const name = doc.createElement('span');
      name.className = 'nm';
      name.textContent = s.name;
      stn.append(dot, name);
      rail.append(stn);
      if (i < railStn.length - 1) {
        const seg = doc.createElement('span');
        seg.className = s.st === 'done' ? 'seg' : 'seg future';
        rail.append(seg);
      }
    });
    host.append(rail);

    // §24.2.3 T2/T7: the loop read-out (loop steps) else the refs read-out (a ticket/PR on any step).
    if (state.loop) {
      host.append(loopReadout(doc, state.loop, deps.loopPanelId));
    } else if (hasFlowRefs(state.refs)) {
      host.append(refsReadout(doc, state.refs, deps.loopPanelId));
    }
    if ((state.loop || hasFlowRefs(state.refs)) && keepLoopFocus) host.querySelector<HTMLElement>('.loopstat')?.focus();
    deps.onPanelState?.(state.loop ?? null, state.stepName, state.refs);

    // Live derived status (§24.2.2 S5): n/m todos done + the §8.3 agent activity, recomputed by main
    // and pushed via flow:onStateChanged.
    if (state.status === 'in_progress' && state.derived && !state.loop) {
      const d = state.derived;
      const line = doc.createElement('div');
      line.className = 'flow-derived';
      line.textContent = `${d.todosDone} / ${d.todosTotal} done · ${d.activity}`;
      host.append(line);
    }

    const control = CONTROL[state.status];
    if (!control) return;

    // Undo takes the advance back to in-progress WITHOUT re-running the step's entry actions —
    // distinct from Restart, which re-runs them.
    if (state.status === 'done') host.append(controlButton('Undo', 'undo'));
    host.append(controlButton(control.label, control.act));

    // Terminate is offered only from in_progress/done (AC1/AC2) and only when the confirmation seam
    // is wired — absent (not in the accessibility tree) otherwise.
    if (deps.onTerminate && (state.status === 'in_progress' || state.status === 'done')) {
      host.append(terminateButton());
    }

    // The §19.3 busy refusal (and any transient notice) rides the transition response only; a later
    // state() re-pull carries none, so the line self-clears.
    if (state.notice) {
      const notice = doc.createElement('div');
      notice.className = 'flow-notice';
      notice.textContent = state.notice;
      host.append(notice);
    }
  }

  /** Hand a step-entry input prompt (§24.2.3 T3) to the composition root's modal via the contract
   *  seam. The prompt is TRANSITION-driven (one-shot, like `notice`): only `applyTransition` calls
   *  this, never a passive `state()` re-pull — a flow:onStateChanged refresh must NOT close an open
   *  modal. `submit` records the typed values (provideInput) and re-applies the response. */
  function emitPrompt(state: FlowStateView): void {
    const boundRepo = repoKey; // bind the submit to the repo the prompt was raised for
    deps.onPrompt?.(state.prompt ?? null, state.stepName, (values) => {
      // A stale submit (cwd moved while the modal was open) must not land on the now-current repo.
      if (boundRepo === null || repoKey !== boundRepo) return;
      deps
        .provideInput(boundRepo, values)
        .then((view) => {
          // The cwd may also move while provideInput is in flight (mirrors controlButton's guard).
          if (repoKey !== boundRepo) return;
          applyTransition(view);
        })
        .catch(() => void refresh());
    });
  }

  /** Repaint from a TRANSITION response and route its one-shot prompt to the modal (open if present,
   *  close if absent). Distinct from a plain render: a `state()` re-pull repaints without touching
   *  the modal. */
  function applyTransition(view: FlowStateView): void {
    render(view);
    // The repaint detached the just-clicked control, dropping focus to <body>. Re-anchor it on a
    // real control so the keyboard user keeps their place (WCAG 2.4.3) — including the Terminate →
    // not_started case, which carries no prompt — and so a following modal restores focus there on
    // close. render() already re-anchors the loop read-out, which leaves focus inside the host.
    if (!host.contains(doc.activeElement)) {
      host.querySelector<HTMLElement>('.flow-control, .flow-undo, .flow-terminate')?.focus();
    }
    emitPrompt(view);
  }

  /** Apply a passive push's live-derived change to the existing DOM, leaving every interactive node
   *  attached (§24.2.2 S5). The caller guarantees the structural signature is unchanged, so only the
   *  loop read-out's tone/iteration and the derived n/m line can differ. */
  function patchInPlace(state: FlowStateView): void {
    const dText = derivedText(state);
    if (dText !== null) {
      const line = host.querySelector('.flow-derived');
      if (line) line.textContent = dText;
    }
    if (state.loop) {
      const pill = host.querySelector<HTMLElement>('.loopstat .spill');
      if (pill) {
        pill.className = `spill ${spillTone(state.loop.status)}`;
        if (pill.lastElementChild) pill.lastElementChild.textContent = toneLabel(state.loop.status);
      }
      const iter = host.querySelector('.loop-iter');
      if (iter) iter.textContent = `iter ${state.loop.iteration}`;
      const cost = host.querySelector('.loop-cost');
      if (cost && state.loop.cost !== undefined) cost.textContent = state.loop.cost;
    }
    // Keep the docked loop panel live — the same hand-off render() makes (§24.2.3 T2/T7). The refs
    // ride along so a value-only patch never clears the panel's "Working on" section.
    deps.onPanelState?.(state.loop ?? null, state.stepName, state.refs);
  }

  async function refresh(): Promise<void> {
    if (repoKey === null) {
      host.replaceChildren();
      lastSig = null;
      return;
    }
    // A state() IPC rejection keeps the last rendered rail rather than escaping as an unhandled
    // rejection or clearing to a blank pane (callers fire `void refresh()`, §18.1).
    let view: FlowStateView;
    try {
      view = await deps.state(repoKey);
    } catch {
      return; // keep the last rendered UI
    }
    // A passive push only ever changes live-derived values, so when the structure is unchanged patch
    // in place — a full teardown would detach a focused control, an in-flight click target, or a
    // confirm dialog's captured opener (§24.2.2 S5). Any structural change falls back to a render.
    if (lastSig !== null && host.childElementCount > 0 && structuralSig(view) === lastSig) {
      patchInPlace(view);
    } else {
      render(view);
    }
  }

  // The push path (§24.2.2 S5): main fires flow:onStateChanged when a flow-relevant input changed,
  // so the derived n/m + activity move with no user action.
  let disposed = false;
  // A push already dispatched (or held by a stale ref) must not repaint a disposed strip — guard
  // the handler as well as unsubscribing (UI-STANDARDS clean teardown).
  const unsubscribe = deps.onStateChanged(() => {
    if (disposed) return;
    void refresh();
  });

  return {
    refresh,
    onRepoChanged(key) {
      repoKey = key;
      lastSig = null; // force a full structural render for the new repo — never patch across repos
      void refresh();
    },
    focusLoopReadout() {
      const el = host.querySelector<HTMLElement>('.loopstat');
      el?.focus();
      return el !== null;
    },
    dispose() {
      disposed = true;
      unsubscribe();
      host.replaceChildren();
    },
  };
}
