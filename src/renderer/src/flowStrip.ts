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

import type { FlowApi, FlowStateView, FlowStatus } from '../../shared/ipc';
import { FLOW_CHANGED_EVENT } from './paneActions';

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

/** The rail always brackets the real step with two synthetic stations: "Not started" (active
 *  before the flow starts) and "Completed" (active once it finishes). The station states are a
 *  pure function of the lifecycle status. */
function railStations(state: FlowStateView): Array<{ name: string; st: StationState }> {
  const status = state.status as Exclude<FlowStatus, 'error'>;
  const notStarted: StationState = status === 'not_started' ? 'active' : 'done';
  const step: StationState = status === 'not_started' ? 'todo' : status === 'in_progress' ? 'active' : 'done';
  const completed: StationState = status === 'done' ? 'active' : 'todo';
  return [
    { name: 'Not started', st: notStarted },
    { name: state.stepName, st: step },
    { name: 'Completed', st: completed },
  ];
}

export interface FlowStrip {
  /** (Re)pull the current repo's flow state and repaint (no-op until a repo key is known). */
  refresh(): Promise<void>;
  /** The terminal's repo changed (cd across a key boundary, §16.3): re-scope and re-pull. */
  onRepoChanged(repoKey: string | null): void;
  /** Unsubscribe from the flow:onStateChanged push so the strip leaks nothing on unmount/remount
   *  (clean teardown — UI-STANDARDS §2.2). */
  dispose(): void;
}

function header(doc: Document, text: string): HTMLElement {
  const sect = doc.createElement('div');
  sect.className = 'sect';
  sect.textContent = text;
  return sect;
}

export function createFlowStrip(host: HTMLElement, deps: FlowApi): FlowStrip {
  const doc = host.ownerDocument;
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
   *  this keeps the UI honest), then re-renders from the returned state. `cls` is `undo`/`advance`/… */
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
          // The repo can change mid-flight (user cd's into another repo); a stale transition must
          // not clobber the current cwd's view — re-pull the now-current repo instead.
          if (repoKey !== key) return void refresh();
          render(view); // re-render from the response, surfacing any one-shot `notice` (§19.3 refusal)
          // The active-step status changed, so the todo overlay's on-demand template picker may
          // appear/disappear — signal it to re-pull (the decoupled contract, §4.1/§9.1).
          window.dispatchEvent(new CustomEvent(FLOW_CHANGED_EVENT));
        })
        .catch(() => void refresh())
        .finally(() => {
          // If no re-render replaced this button (transition failed and the follow-up refresh also
          // bailed on an IPC error), re-enable it so the user can retry (§16.4); a render() detaches
          // it, in which case host.contains is false and this is a no-op.
          if (host.contains(button)) button.disabled = false;
        });
    });
    return button;
  }

  let lastStatus: FlowStateView['status'] | null = null;

  function render(state: FlowStateView): void {
    lastStatus = state.status;
    host.replaceChildren();

    if (state.status === 'error') {
      host.append(header(doc, 'Flow'));
      const err = doc.createElement('div');
      err.className = 'flow-error';
      err.textContent = state.error ?? 'flow failed to load';
      host.append(err);
      return;
    }

    // The rail brackets the real step with synthetic bookends, so its active station — and the
    // header position — walks the synthetic-inclusive sequence: 1/3 → 2/3 → 3/3.
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

    // Live derived status (§24.2.2 S5): n/m todos done + the §8.3 agent activity, recomputed by
    // main and pushed via flow:onStateChanged. Present only while the step is in progress.
    if (state.status === 'in_progress' && state.derived) {
      const d = state.derived;
      const line = doc.createElement('div');
      line.className = 'flow-derived';
      // The live region rides this non-interactive text, not the strip container, which holds the
      // focusable Start/Advance/Restart/Undo controls (a live region must not wrap them — a11y).
      line.setAttribute('role', 'status');
      line.setAttribute('aria-live', 'polite');
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
      notice.setAttribute('role', 'status');
      notice.setAttribute('aria-live', 'polite');
      notice.textContent = state.notice;
      host.append(notice);
    }
  }

  async function refresh(): Promise<void> {
    if (repoKey === null) {
      host.replaceChildren(); // no repo yet → nothing to show (the strip follows the cwd)
      return;
    }
    const key = repoKey;
    // render() rebuilds the subtree, so a focused control would be dropped to <body> on a push-driven
    // re-render; capture which control held focus and restore it after (§22.4 keyboard order).
    const active = doc.activeElement;
    const refocus =
      active instanceof HTMLElement && host.contains(active)
        ? active.classList.contains('flow-undo')
          ? '.flow-undo'
          : '.flow-control'
        : null;
    let view: FlowStateView;
    try {
      view = await deps.state(key);
    } catch {
      return; // IPC failure (main restart): keep the prior UI, never an unhandled rejection (§16.4)
    }
    if (repoKey !== key) return; // repo changed mid-flight → a newer refresh owns the render
    render(view);
    if (refocus) host.querySelector<HTMLElement>(refocus)?.focus();
  }

  // The push path (§24.2.2 S5): main fires flow:onStateChanged when a flow-relevant input changed
  // (a todo mutated, the agent flipped active/quiet); the strip re-pulls its own repo's state so the
  // derived n/m + activity move with no user action. Lives for the strip's lifetime (app-long).
  // Only re-pull while a step is in_progress — that is the sole state whose view a push can change
  // (derived is in_progress-only). Skipping it elsewhere keeps an unrelated activity flip from
  // wiping the done-state §19.2 one-shot notice (which a re-pull would clear) and from rebuilding
  // (losing focus) when nothing visible changed.
  const unsubscribe = deps.onStateChanged(() => {
    if (lastStatus === 'in_progress') void refresh();
  });

  return {
    refresh,
    onRepoChanged(key) {
      repoKey = key;
      void refresh();
    },
    dispose: unsubscribe,
  };
}
