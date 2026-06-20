// The docked loop+gate panel (§24.2.3 T2) — a placement-agnostic organism (UI-STANDARDS §1.2) that
// renders the EXPANDED read-only agent-loop state mirror the rail's compact Loop read-out opens. It
// reproduces design/shell/loop-flow.html's State section at fidelity: a `.lhead` title + the v4
// `.ldl` detail rows (status / iteration / pr / branch). It touches only its host subtree and renders
// identically wherever mounted. The shell owns docking the column; the read-out owns the open toggle.
//
// Scope (T2): the state mirror + the read-only "gate options" row (the current gate's `human_options`,
// resolved from the bound LoopDef). The Review-gate DECISION section (the actual approve /
// request-changes / impasse buttons + the §19.4 composer) is the gate slice T5/T6 — not built here.

import type { FlowLoopView } from '../../shared/ipc';
import { spillTone } from './loopStatus';

/** Display label for a gate `human_option` — matches loop-flow.html's "approve · changes · impasse"
 *  (the verbose `request-changes` reads as `changes` in the compact options row). */
function gateOptionLabel(option: string): string {
  return option === 'request-changes' ? 'changes' : option;
}

export interface LoopPanel {
  /** Repaint from the current loop mirror; `null` (no loop step / no parseable state.yaml) clears it.
   *  `title` identifies which loop step the panel mirrors (the rail step name). */
  render(loop: FlowLoopView | null, title: string): void;
}

function detailRow(key: string, value: string, valueClass = ''): HTMLElement {
  const r = document.createElement('div');
  r.className = 'lrow';
  const k = document.createElement('span');
  k.className = 'lk';
  k.textContent = key;
  const lead = document.createElement('span'); // the dotted leader between key and value
  lead.className = 'ld';
  const v = document.createElement('span');
  v.className = valueClass ? `lv ${valueClass}` : 'lv';
  v.textContent = value;
  r.append(k, lead, v);
  return r;
}

export function createLoopPanel(host: HTMLElement): LoopPanel {
  return {
    render(loop, title) {
      host.replaceChildren();
      if (!loop) return;

      const head = document.createElement('div');
      head.className = 'lhead';
      const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('class', 'loopmark');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#loop-orbit');
      mark.append(use);
      const h3 = document.createElement('h3');
      h3.className = 'serif';
      h3.textContent = title;
      const close = document.createElement('button');
      close.className = 'iconbtn x';
      close.id = 'lclose';
      close.title = 'Close loop panel';
      close.setAttribute('aria-label', 'Close loop panel');
      close.textContent = '✕';
      head.append(mark, h3, close);
      host.append(head);

      const body = document.createElement('div');
      body.className = 'lbody';
      const segH = document.createElement('div');
      segH.className = 'seg-h';
      segH.textContent = 'State · .agent-loop/state.yaml (v4)';
      body.append(segH);

      const ldl = document.createElement('div');
      ldl.className = 'ldl';
      // An awaiting-human status still needs the human — the §22.3 "act" tone (`bad`).
      ldl.append(detailRow('status', loop.status, spillTone(loop.status) === 'await' ? 'bad' : ''));
      ldl.append(detailRow('iteration', String(loop.iteration)));
      if (loop.pr !== null) ldl.append(detailRow('pr', `#${loop.pr}`, 'sig'));
      if (loop.branch !== null) ldl.append(detailRow('branch', loop.branch));
      // The current gate's human_options (§18.1/§19.4) — present only at an awaiting gate. The actual
      // decision buttons are T5/T6; this row just surfaces what the gate will offer.
      if (loop.gateOptions && loop.gateOptions.length > 0)
        ldl.append(detailRow('gate options', loop.gateOptions.map(gateOptionLabel).join(' · ')));

      const grow = document.createElement('div');
      grow.className = 'grow';
      grow.textContent = '+ extensible — reviewer count, last verdict, timings slot in here as the bridge derives them.';
      ldl.append(grow);
      body.append(ldl);
      host.append(body);
    },
  };
}
