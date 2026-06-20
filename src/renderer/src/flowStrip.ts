// Flow status strip (§22.3 / §24.2.2) — a placement-agnostic organism (UI-STANDARDS §1.2)
// that renders with 100% fidelity to the §24.1 mockup (design/shell/converged.html): a
// `Flow — step N / M` section header and a vertical station rail (`.flow.vert` → `.stn` with
// circle `.o` + name `.nm`, `.seg` connectors between). The real step is bracketed by two
// synthetic stations — "Not started" (active before the flow starts) and "Completed" (active
// once it finishes) — so the rail is always [Not started] · <step> · [Completed]. Below it
// sits one control following the lifecycle — Start → Advance → Restart (re-running the step).
// A load failure (§18.1) has no mockup counterpart; by decision it renders as a single
// `--danger` text line under the header, with no station and no control.
//
// It follows the terminal's cwd, mirroring the repo-scoped todo list (§16.3): it holds the
// current repoKey, re-pulls/re-renders on `onRepoChanged`, and threads that key into every
// window.flow call. Before a repo key is known it renders nothing. It reaches for nothing: the
// flow lifecycle is injected as `deps` (the window.flow IPC seam), each call returning the
// resulting state so the strip re-renders from the response.

import type { FlowApi, FlowStateView, FlowStatus, FlowLoopView, FlowPrompt } from '../../shared/ipc';
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
 *  … · stepₙ · [Completed] (§24.2.3 T1 generalized the bookends across N real steps). Station states
 *  are a pure function of the current step's `position` and the lifecycle status. */
function railStations(state: FlowStateView): Array<{ name: string; st: StationState }> {
  const status = state.status as Exclude<FlowStatus, 'error'>;
  const currentIndex = state.position - 1; // 0-based index of the current real step
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
}

/** The strip's deps: the flow IPC seam plus an optional hand-off of the current loop mirror to the
 *  composition root (§24.2.3 T2) — it routes the data to the sibling docked panel without the strip
 *  reaching across organisms. Fired on every render: `null` when the step has no loop mirror. */
export type FlowStripDeps = FlowApi & {
  onLoopState?: (loop: FlowLoopView | null, title: string) => void;
  /** Hand a step-entry input prompt (§24.2.3 T3) to the composition root, which opens its modal
   *  organism. `submit` records the typed values (provideInput) and re-renders. `null` closes the
   *  modal (no prompt on this view). The strip never reaches across to the modal directly. */
  onPrompt?: (prompt: FlowPrompt | null, stepName: string, submit: (values: Record<string, string>) => void) => void;
};

function header(doc: Document, text: string): HTMLElement {
  const sect = doc.createElement('div');
  sect.className = 'sect';
  sect.textContent = text;
  return sect;
}

/** The compact read-only loop read-out (§24.2.3 T2) shown in the rail: a 3-tone status pill (the
 *  one-word tone, not the unbounded status) + the iteration, framed as a `role=button` that opens
 *  the docked panel (the shell wires the click). The exact v4 vocabulary lives in that panel. */
function loopReadout(doc: Document, loop: FlowLoopView): HTMLElement {
  const stat = doc.createElement('span');
  stat.className = 'stat loopstat';
  stat.id = 'loopstat';
  stat.setAttribute('role', 'button');
  stat.tabIndex = 0;
  stat.setAttribute('aria-expanded', 'false');
  stat.setAttribute('aria-controls', 'loop-panel');

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
  v.append(pill, iter, car);

  stat.append(k, v);
  return stat;
}

export function createFlowStrip(host: HTMLElement, deps: FlowStripDeps): FlowStrip {
  const doc = host.ownerDocument; // build from the host's document so the strip relocates (UI §2.2.1)
  let repoKey: string | null = null;

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
          // Re-render from the response, surfacing any one-shot `notice` (§19.3 refusal) and routing a
          // step-entry input prompt to the modal (§24.2.3 T3) — both ride the transition, not state().
          applyTransition(view);
          // The active-step status changed, so the todo overlay's on-demand template picker may
          // appear/disappear — signal it to re-pull (the decoupled contract, §4.1/§9.1).
          window.dispatchEvent(new CustomEvent(FLOW_CHANGED_EVENT));
        })
        .catch(() => void refresh());
    });
    return button;
  }

  function render(state: FlowStateView): void {
    // A background push repaints the whole rail; if the keyboard user was on the Loop read-out, carry
    // their focus across the rebuild rather than dropping it to <body> (WCAG 2.4.3).
    const keepLoopFocus = doc.activeElement instanceof HTMLElement && doc.activeElement.id === 'loopstat' && host.contains(doc.activeElement);
    host.replaceChildren();

    if (state.status === 'error') {
      host.append(header(doc, 'Flow'));
      const err = doc.createElement('div');
      err.className = 'flow-error';
      err.textContent = state.error ?? 'flow failed to load';
      host.append(err);
      deps.onLoopState?.(null, ''); // no step → the docked panel clears + closes
      return;
    }

    // The rail brackets the real steps with synthetic bookends, so its active station — and the
    // header position — walks the synthetic-inclusive sequence (e.g. 1/3 → 2/3 → 3/3 for one step,
    // 1/5 → … → 5/5 for three).
    const railStn = railStations(state);
    const activeIndex = railStn.findIndex((s) => s.st === 'active');
    host.append(header(doc, `Flow — step ${activeIndex + 1} / ${railStn.length}`));

    // The station rail (§24.1 mockup): a vertical `.flow` of `.stn` (circle `.o` + name `.nm`),
    // `.seg` connectors between (dashed `.future` ahead of a not-yet-reached station), exactly
    // as design/shell/converged.html.
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

    // A loop step mirrors its agent-loop state.yaml read-only (§24.2.3 T2): the rail shows a compact
    // read-out that opens the docked panel, and the full mirror is handed to that panel via onLoopState.
    // The loop's own status is the live signal, so it supersedes the todo-derived line (todos don't
    // drive a loop). null clears + closes the panel on a non-loop step.
    if (state.loop) {
      host.append(loopReadout(doc, state.loop));
      if (keepLoopFocus) host.querySelector<HTMLElement>('#loopstat')?.focus();
    }
    deps.onLoopState?.(state.loop ?? null, state.stepName);

    // Live derived status (§24.2.2 S5): n/m todos done + the §8.3 agent activity, recomputed by
    // main and pushed via flow:onStateChanged. Present only while the step is in progress.
    if (state.status === 'in_progress' && state.derived && !state.loop) {
      const d = state.derived;
      const line = doc.createElement('div');
      line.className = 'flow-derived';
      line.textContent = `${d.todosDone} / ${d.todosTotal} done · ${d.activity}`;
      host.append(line);
    }

    const control = CONTROL[state.status];
    if (!control) return;

    // A completed (manual-advanced) step can always be undone back to in-progress — taking back the
    // advance WITHOUT re-running the step's entry actions (distinct from Restart, which re-runs them).
    if (state.status === 'done') host.append(controlButton('Undo', 'undo'));
    host.append(controlButton(control.label, control.act));

    // The §19.3 busy refusal (and any other transient notice) rides the start/restart response
    // only; a later state() re-pull carries none, so the line self-clears.
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
      // The cwd may move while the (blocking) modal is open; a stale submit must not land the value
      // on the now-current repo — drop it rather than write to the wrong flow.
      if (boundRepo === null || repoKey !== boundRepo) return;
      deps.provideInput(boundRepo, values).then(applyTransition).catch(() => void refresh());
    });
  }

  /** Repaint from a TRANSITION response and route its one-shot prompt to the modal (open if present,
   *  close if absent). Distinct from a plain render: a `state()` re-pull repaints without touching
   *  the modal. */
  function applyTransition(view: FlowStateView): void {
    render(view);
    emitPrompt(view);
  }

  async function refresh(): Promise<void> {
    if (repoKey === null) {
      host.replaceChildren(); // no repo yet → nothing to show (the strip follows the cwd)
      return;
    }
    render(await deps.state(repoKey));
  }

  // The push path (§24.2.2 S5): main fires flow:onStateChanged when a flow-relevant input changed
  // (a todo mutated, the agent flipped active/quiet); the strip re-pulls its own repo's state so the
  // derived n/m + activity move with no user action. Lives for the strip's lifetime (app-long).
  deps.onStateChanged(() => void refresh());

  return {
    refresh,
    onRepoChanged(key) {
      repoKey = key;
      void refresh();
    },
  };
}
