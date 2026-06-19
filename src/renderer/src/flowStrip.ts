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

import type { FlowApi, FlowStateView, FlowStatus, TodoTemplateRef } from '../../shared/ipc';
import { TODOS_CHANGED_EVENT } from './paneActions';

type StationState = 'todo' | 'active' | 'done';
type Act = 'start' | 'advance' | 'restart';

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
}

function header(text: string): HTMLElement {
  const sect = document.createElement('div');
  sect.className = 'sect';
  sect.textContent = text;
  return sect;
}

export function createFlowStrip(host: HTMLElement, deps: FlowApi): FlowStrip {
  let repoKey: string | null = null;
  // Bumped on every render so a slow async template fetch can't paint onto a host a newer render
  // already replaced (stale-append guard).
  let gen = 0;

  // The on-demand picker (§4.1/§6): a select of templates by user-facing name (defaulting to the
  // step's bound template) + a control that instantiates the chosen one and signals the todo panel.
  function templatePicker(key: string, templates: TodoTemplateRef[], defaultRef?: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'flow-template';
    const select = document.createElement('select');
    select.className = 'flow-template-pick';
    select.setAttribute('aria-label', 'Todo template');
    for (const t of templates) {
      const opt = document.createElement('option');
      opt.value = t.ref;
      opt.textContent = t.name;
      select.append(opt);
    }
    if (defaultRef && templates.some((t) => t.ref === defaultRef)) select.value = defaultRef;
    const add = document.createElement('button');
    add.className = 'flow-template-add pill';
    add.textContent = 'Add todos from template';
    add.addEventListener('click', () => {
      add.disabled = true;
      deps
        .instantiateTemplate(key, select.value)
        .then(() => window.dispatchEvent(new CustomEvent(TODOS_CHANGED_EVENT)))
        .finally(() => {
          add.disabled = false;
        });
    });
    wrap.append(select, add);
    return wrap;
  }

  function render(state: FlowStateView): void {
    const myGen = ++gen;
    host.replaceChildren();

    if (state.status === 'error') {
      host.append(header('Flow'));
      const err = document.createElement('div');
      err.className = 'flow-error';
      err.textContent = state.error ?? 'flow failed to load';
      host.append(err);
      return;
    }

    // The rail brackets the real step with synthetic bookends, so its active station — and the
    // header position — walks the synthetic-inclusive sequence: 1/3 → 2/3 → 3/3.
    const railStn = railStations(state);
    const activeIndex = railStn.findIndex((s) => s.st === 'active');
    host.append(header(`Flow — step ${activeIndex + 1} / ${railStn.length}`));

    // The station rail (§24.1 mockup): a vertical `.flow` of `.stn` (circle `.o` + name `.nm`),
    // `.seg` connectors between (dashed `.future` ahead of a not-yet-reached station), exactly
    // as design/shell/converged.html.
    const rail = document.createElement('div');
    rail.className = 'flow vert';
    railStn.forEach((s, i) => {
      const stn = document.createElement('span');
      stn.className = `stn ${s.st}`;
      const dot = document.createElement('span');
      dot.className = 'o';
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = s.name;
      stn.append(dot, name);
      rail.append(stn);
      if (i < railStn.length - 1) {
        const seg = document.createElement('span');
        seg.className = s.st === 'done' ? 'seg' : 'seg future';
        rail.append(seg);
      }
    });
    host.append(rail);

    const control = CONTROL[state.status];
    if (!control) return;

    const button = document.createElement('button');
    button.className = 'flow-control pill';
    button.textContent = control.label;
    button.addEventListener('click', () => {
      // Disable while the transition is in flight so a double-click can't fire it twice
      // (the machine would reject the second call anyway — §24.2.2 — but this keeps the UI
      // honest). Re-render from the returned state.
      if (repoKey === null) return;
      const key = repoKey;
      button.disabled = true;
      const next =
        control.act === 'start' ? deps.start(key) : control.act === 'advance' ? deps.advance(key) : deps.restart(key);
      // Re-render from the response, surfacing any one-shot `notice` (§19.3 busy refusal). Entry
      // no longer instantiates todos, so no todos-changed signal here.
      next.then(render).catch(() => void refresh());
    });
    host.append(button);

    // On-demand todo-template picker (§4.1/§6): while the step is ACTIVE, fetch the templates
    // co-located with its flow.yaml and, if any exist, offer a picker to instantiate a chosen one
    // into the todo list — signalling the panel to re-pull (the contract, as selection.ts does).
    // Templates are never auto-run; the fetch is async, so guard against a stale paint.
    if (state.status === 'in_progress' && repoKey !== null) {
      const key = repoKey;
      void deps.listTemplates(key).then((templates) => {
        if (myGen !== gen || templates.length === 0) return;
        host.append(templatePicker(key, templates, state.templateRef));
      });
    }

    // The §19.3 busy refusal (and any other transient notice) rides the start/restart response
    // only; a later state() re-pull carries none, so the line self-clears.
    if (state.notice) {
      const notice = document.createElement('div');
      notice.className = 'flow-notice';
      notice.textContent = state.notice;
      host.append(notice);
    }
  }

  async function refresh(): Promise<void> {
    if (repoKey === null) {
      host.replaceChildren(); // no repo yet → nothing to show (the strip follows the cwd)
      return;
    }
    render(await deps.state(repoKey));
  }

  return {
    refresh,
    onRepoChanged(key) {
      repoKey = key;
      void refresh();
    },
  };
}
