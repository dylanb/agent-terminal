// The docked loop+gate panel (§24.2.3 T2/T7) — a placement-agnostic organism (UI-STANDARDS §1.2).
// It renders two read-only sections: the ticket/PR the flow is working (T7), shown whenever the flow
// is active even on a non-loop step; and the EXPANDED agent-loop state mirror (T2) on loop steps. The
// ticket/PR detail (title, body, link) is fetched best-effort via injected services — the organism
// reaches for nothing itself.
//
// Scope (T2): the state mirror + the read-only "gate options" row. The Review-gate DECISION section
// (the approve / request-changes / impasse buttons + the §19.4 composer) is the gate slice T5/T6 —
// not built here.

import type { FlowLoopView, FlowRefs, GithubRef, GithubRefKind } from '../../shared/ipc';
import { hasFlowRefs } from '../../shared/ipc';
import { githubHttpsHref } from '../../shared/githubUrl';
import { spillTone } from './loopStatus';

/** Display label for a gate `human_option` — matches loop-flow.html's "approve · changes · impasse"
 *  (the verbose `request-changes` reads as `changes` in the compact options row). */
function gateOptionLabel(option: string): string {
  return option === 'request-changes' ? 'changes' : option;
}

/** The §24.2.3 T7 services the panel needs: resolve a ref's detail (best-effort; null → bare number)
 *  and open its url externally. Injected by the composition root; the organism never reaches for them. */
export interface LoopPanelDeps {
  githubRef(kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): void;
}

const NOOP_DEPS: LoopPanelDeps = { githubRef: () => Promise.resolve(null), openExternal: () => {} };

const BODY_MAX = 200;
function truncateBody(body: string): string {
  const t = body.trim();
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX).trimEnd()}…` : t;
}

export interface LoopPanel {
  /** Repaint from the current flow refs + loop mirror; both `null`/absent clears the host. `title`
   *  identifies the step the panel mirrors (the rail step name). */
  render(loop: FlowLoopView | null, title: string, refs?: FlowRefs): void;
  /** Clean teardown (UI-STANDARDS). */
  dispose(): void;
}

function detailRow(doc: Document, key: string, value: string, valueClass = ''): HTMLElement {
  const r = doc.createElement('div');
  r.className = 'lrow';
  const k = doc.createElement('span');
  k.className = 'lk';
  k.textContent = key;
  const lead = doc.createElement('span');
  lead.className = 'ld';
  const v = doc.createElement('span');
  v.className = valueClass ? `lv ${valueClass}` : 'lv';
  v.textContent = value;
  r.append(k, lead, v);
  return r;
}

/** A signature of everything the panel renders, so an identical re-render can be skipped. The async
 *  title/body/link fill the DOM in place keyed by the same (kind, number), so they need not be in it. */
function panelSig(loop: FlowLoopView | null, title: string, refs?: FlowRefs): string {
  return JSON.stringify([
    title,
    refs?.ticket ?? null,
    refs?.pr ?? null,
    loop ? [loop.status, loop.iteration, loop.pr, loop.branch, loop.gateOptions ?? null] : null,
  ]);
}

export function createLoopPanel(host: HTMLElement, deps: LoopPanelDeps = NOOP_DEPS): LoopPanel {
  const doc = host.ownerDocument; // build from the host's document so the panel relocates (UI §2.2.1)
  // The structure last painted; an unchanged signature skips the rebuild so a passive push (e.g. an
  // agent active/quiet flip, which carries no panel change) doesn't flicker or drop focus to <body>.
  let lastSig: string | null = null;

  /** Where focus sits inside the panel, as a token survivable across a rebuild (the close control or a
   *  ref row's link), or null when focus is elsewhere. */
  function captureFocus(): string | null {
    const active = doc.activeElement;
    if (!(active instanceof HTMLElement) || !host.contains(active)) return null;
    const link = active.closest('a.reflink');
    if (link) return `reflink:${link.closest('.rrow')?.querySelector('.rk')?.textContent ?? ''}`;
    return 'close'; // the close control or any other in-panel focusable lands back on close
  }

  /** Restore focus after a rebuild to the matching element, falling back to the close control (always
   *  present on a populated panel) so a forced repaint never strands focus on <body> (WCAG 2.4.3). */
  function restoreFocus(token: string | null): void {
    if (!token) return;
    if (token.startsWith('reflink:')) {
      const key = token.slice('reflink:'.length);
      const link = [...host.querySelectorAll<HTMLElement>('.rrow')]
        .find((r) => r.querySelector('.rk')?.textContent === key)
        ?.querySelector<HTMLElement>('a.reflink');
      if (link) return void link.focus();
    }
    host.querySelector<HTMLElement>('[data-loop-close]')?.focus();
  }

  function refRow(label: string, kind: GithubRefKind, number: number): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'rrow';
    const k = doc.createElement('span');
    k.className = 'rk';
    k.textContent = label;
    const num = doc.createElement('span');
    num.className = 'rnum';
    num.textContent = `#${number}`;
    const title = doc.createElement('span');
    title.className = 'rtitle';
    const body = doc.createElement('p');
    body.className = 'rbody';
    row.append(k, num, title, body);

    void deps.githubRef(kind, number).then((ref) => {
      if (!ref || !row.isConnected) return;
      title.textContent = ref.title;
      body.textContent = truncateBody(ref.body);
      // Validate the url at the sink against the same allow-list main enforces (CWE-601): a non-GitHub
      // url keeps the bare number and exposes no href a middle-click could open.
      const href = githubHttpsHref(ref.url);
      if (!href) return;
      const link = doc.createElement('a');
      link.className = 'reflink';
      link.href = href;
      link.textContent = `#${number}`;
      // The visible text is just the number; name the link's purpose for assistive tech (WCAG 2.4.4).
      link.setAttribute('aria-label', `${label} #${number}: ${ref.title} (opens in browser)`);
      link.addEventListener('click', (e) => {
        e.preventDefault();
        deps.openExternal(href);
      });
      num.replaceWith(link);
    });
    return row;
  }

  return {
    render(loop, title, refs) {
      const showRefs = hasFlowRefs(refs);
      const sig = !loop && !showRefs ? null : panelSig(loop, title, refs);
      if (sig === lastSig) return; // nothing the panel shows changed — keep the live DOM and its focus
      const focus = captureFocus();
      host.replaceChildren();
      lastSig = sig;
      if (!loop && !showRefs) return;

      const head = doc.createElement('div');
      head.className = 'lhead';
      const mark = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      mark.setAttribute('class', 'loopmark');
      const use = doc.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#loop-orbit');
      mark.append(use);
      const h3 = doc.createElement('h3');
      h3.className = 'serif';
      h3.textContent = title;
      const close = doc.createElement('button');
      close.className = 'iconbtn x';
      close.dataset.loopClose = ''; // shell's close hook — not a global id (would collide across panels)
      close.title = 'Close loop panel';
      close.setAttribute('aria-label', 'Close loop panel');
      close.textContent = '✕';
      head.append(mark, h3, close);
      host.append(head);

      if (showRefs && refs) {
        const refsEl = doc.createElement('div');
        refsEl.className = 'refs';
        const segH = doc.createElement('div');
        segH.className = 'seg-h';
        segH.textContent = 'Working on';
        refsEl.append(segH);
        if (refs.ticket !== undefined) refsEl.append(refRow('Ticket', 'issue', refs.ticket));
        if (refs.pr !== undefined) refsEl.append(refRow('PR', 'pr', refs.pr));
        host.append(refsEl);
      }

      if (!loop) {
        restoreFocus(focus);
        return;
      }

      const body = doc.createElement('div');
      body.className = 'lbody';
      const segH = doc.createElement('div');
      segH.className = 'seg-h';
      segH.textContent = 'State · .agent-loop/state.yaml (v4)';
      body.append(segH);

      const ldl = doc.createElement('div');
      ldl.className = 'ldl';
      // An awaiting-human status still needs the human — the §22.3 "act" tone (`bad`).
      ldl.append(detailRow(doc, 'status', loop.status, spillTone(loop.status) === 'await' ? 'bad' : ''));
      ldl.append(detailRow(doc, 'iteration', String(loop.iteration)));
      if (loop.pr !== null) ldl.append(detailRow(doc, 'pr', `#${loop.pr}`, 'sig'));
      if (loop.branch !== null) ldl.append(detailRow(doc, 'branch', loop.branch));
      // The current gate's human_options (§18.1/§19.4), present only at an awaiting gate; the decision
      // buttons are T5/T6 — this row only surfaces what the gate will offer.
      if (loop.gateOptions && loop.gateOptions.length > 0)
        ldl.append(detailRow(doc, 'gate options', loop.gateOptions.map(gateOptionLabel).join(' · ')));

      body.append(ldl);
      host.append(body);
      restoreFocus(focus);
    },
    dispose() {
      host.replaceChildren();
      lastSig = null;
    },
  };
}
