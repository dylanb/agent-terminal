// The docked loop+gate panel (§24.2.3 T2/T7) — a placement-agnostic organism (UI-STANDARDS §1.2).
// It renders two read-only sections: the ticket/PR the flow is working (T7), shown whenever the flow
// is active even on a non-loop step; and the EXPANDED agent-loop state mirror (T2) on loop steps. The
// ticket/PR detail (title, body, link) is fetched best-effort via injected services — the organism
// reaches for nothing itself.
//
// Scope: the state mirror + the read-only "gate options" row, plus the §26.6 / L5 gate DECISION section
// (a button per gate option, firing the injected gateDecision). The §19.4 feedback composer that supplies
// the human-note text is a later slice.

import type { FlowLoopView, FlowRefs, GithubRef, GithubRefKind } from '../../shared/ipc';
import { hasFlowRefs } from '../../shared/ipc';
import { loopGateActionable } from '../../shared/loopGate';
import { githubHttpsHref } from '../../shared/githubUrl';
import { spillTone } from './loopStatus';
import { captureSubtreeFocus } from './dom';

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
  /** §26.3/D47a(c) — the operator's manual "this turn is done" override for a turn whose automatic
   *  done-signal was missed. Injected by the composition root; absent → the control is inert. */
  markTurnComplete?(): void;
  /** §26.6 / L5 — submit the human's gate decision (the option the human picked at an awaiting gate).
   *  Injected by the composition root; absent → the decision buttons are not rendered. */
  gateDecision?(option: string): void;
  /** §26.3/D48 — recover a loop stopped in `error`: re-drive the failed turn (e.g. after starting Claude
   *  for a `no hosted agent` stop). Injected by the composition root; absent → no Retry control is shown,
   *  so an errored loop is never a dead-end reachable only by Terminate (never-unrecoverable, CLAUDE.md). */
  retryTurn?(): void;
}

const NOOP_DEPS: LoopPanelDeps = { githubRef: () => Promise.resolve(null), openExternal: () => {} };

const BODY_MAX = 200;
function truncateBody(body: string): string {
  const t = body.trim();
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX).trimEnd()}…` : t;
}

export interface LoopPanel {
  /** Repaint from the current flow refs + loop mirror; both `null`/absent clears the host. `title`
   *  identifies the step the panel mirrors (the rail step name). A clearing call (both absent) must be
   *  preceded by moving focus out of the host — the close-before-clear contract `syncDockedPanel` holds
   *  (UI §4.5) — so emptying never strands focus on `<body>`. */
  render(loop: FlowLoopView | null, title: string, refs?: FlowRefs): void;
  /** Move focus onto the gate decision, recovery Retry, or stable Close entry, returning whether one was
   *  there to focus. The panel owns this so a sibling never reaches into its markup for the control
   *  (§26.6 / §26.3 D48; WCAG 2.4.3). */
  focusDecision(): boolean;
  /** Clean teardown (UI-STANDARDS). */
  dispose(): void;
}

function detailRow(doc: Document, key: string, value: string, valueClass = ''): HTMLElement {
  const r = doc.createElement('div');
  r.className = 'lrow';
  // WCAG 4.1.3 — patchInPlace mutates only the value span; aria-atomic makes the live region announce the
  // whole row (label + value, "iteration 3") rather than the bare value node that changed.
  r.setAttribute('aria-atomic', 'true');
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

/** A signature of what fixes the panel's DOM STRUCTURE — deliberately NOT the live loop values
 *  (status/iteration/error reason) that `patchInPlace` updates without a teardown (mirrors flowStrip's
 *  structuralSig, §24.2.2 S5). The async ref title/body/link fill the DOM in place keyed by (kind,
 *  number), so they are excluded too. The error reason and its Retry control are excluded because
 *  rebuilding the live region to show them would announce nothing at all (WCAG SC 4.1.3). */
function structuralSig(loop: FlowLoopView | null, title: string, refs?: FlowRefs): string {
  return JSON.stringify([
    title,
    refs?.ticket ?? null,
    refs?.pr ?? null,
    // iteration PRESENCE and actionability are structural: the iteration row and the gate-decision
    // buttons appear/disappear with them, so a run-less↔run transition forces a full render.
    loop ? [loop.pr, loop.branch, loop.gateOptions ?? null, loop.iteration !== undefined, loop.actionable ?? null] : null,
  ]);
}

export function createLoopPanel(host: HTMLElement, deps: LoopPanelDeps = NOOP_DEPS): LoopPanel {
  const doc = host.ownerDocument; // build from the host's document so the panel relocates (UI §2.2.1)
  let lastSig: string | null = null;
  // Live nodes patched without a teardown (mirrors flowStrip), and the ref rows whose detail is still
  // unresolved so a structurally-unchanged push can re-attempt them (githubRefs never caches a null —
  // src/main/githubRefs.ts — so a transient failure only self-heals if the caller re-fetches).
  let liveLoop: { statusVal: HTMLElement; iterVal: HTMLElement | null; ldl: HTMLElement; reasonAnchor: HTMLElement; body: HTMLElement } | null = null;
  let refRows: Array<{ retry: () => void; resolved: () => boolean }> = [];

  /** §26.3/D48 — the `reason` row, kept INSIDE the surviving live region so entering error announces it as
   *  an addition (WCAG SC 4.1.3) instead of silently recreating the region around it. `anchor` is the
   *  iteration row when a round has run, else the status row (a run-less §27 failure carries no iteration). */
  const syncReasonRow = (ldl: HTMLElement, anchor: HTMLElement, reason: string | undefined): void => {
    const existing = ldl.querySelector<HTMLElement>('[data-loop-reason]');
    if (!reason) {
      existing?.remove();
      return;
    }
    if (existing) {
      const v = existing.querySelector('.lv')!;
      if (v.textContent !== reason) v.textContent = reason;
      return;
    }
    const row = detailRow(doc, 'reason', reason, 'bad');
    row.dataset.loopReason = '';
    anchor.after(row);
  };

  /** §26.3/D48 — recovery from the error stop: re-drive the failed turn (start Claude, then Retry) so an
   *  errored loop is never a UI dead-end. Error-only + service-gated (an un-wired control would be inert,
   *  WCAG 4.1.2). */
  const syncRetry = (body: HTMLElement, loop: FlowLoopView): void => {
    const existing = body.querySelector<HTMLElement>('[data-loop-retry]');
    // Retry re-drives the errored TURN (§26.3/D48); a run-less failure (no iteration — a §27 def that
    // never resolved) has no turn to re-drive, so rendering Retry would be an inert affordance (WCAG 4.1.2).
    if (loop.status !== 'error' || loop.iteration === undefined || !deps.retryTurn) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const retryBtn = doc.createElement('button');
    retryBtn.className = 'pill retry';
    retryBtn.dataset.loopRetry = '';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => deps.retryTurn?.());
    body.append(retryBtn);
  };

  /** A ticket/PR ref row. `retry` re-attempts the best-effort `gh` fetch (no-op once resolved); the row
   *  shows the bare number until the title/body/link fill in. */
  function refRow(label: string, kind: GithubRefKind, number: number): { el: HTMLElement; retry: () => void; resolved: () => boolean } {
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

    let resolved = false;
    let pending = false;
    const attempt = (): void => {
      if (resolved || pending) return;
      pending = true;
      void deps
        .githubRef(kind, number)
        .then((ref) => {
          if (!ref || resolved || !row.isConnected) return;
          resolved = true;
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
        })
        .catch(() => {}) // a rejected invoke (main restart) must not be an unhandled rejection
        .finally(() => {
          pending = false;
        });
    };
    attempt();
    return { el: row, retry: attempt, resolved: () => resolved };
  }

  /** Update the live loop values + re-attempt any unresolved ref, with no teardown so focus and the
   *  resolved DOM survive a passive push whose structure is unchanged (§24.2.2 S5). */
  function patchInPlace(loop: FlowLoopView | null): void {
    if (loop && liveLoop) {
      // WCAG 4.1.3 — only touch the live-region text on a real change; an unchanged passive push (cost/refs
      // only) must not rewrite these nodes, or a screen reader re-announces content that did not change.
      if (liveLoop.statusVal.textContent !== loop.status) liveLoop.statusVal.textContent = loop.status;
      liveLoop.statusVal.classList.toggle('bad', spillTone(loop.status) === 'await');
      if (liveLoop.iterVal && loop.iteration !== undefined) {
        const iter = String(loop.iteration);
        if (liveLoop.iterVal.textContent !== iter) liveLoop.iterVal.textContent = iter;
      }
      syncReasonRow(liveLoop.ldl, liveLoop.reasonAnchor, loop.errorReason);
      syncRetry(liveLoop.body, loop);
    }
    for (const r of refRows) if (!r.resolved()) r.retry();
  }

  return {
    render(loop, title, refs) {
      const showRefs = hasFlowRefs(refs);
      const sig = !loop && !showRefs ? null : structuralSig(loop, title, refs);
      if (sig === lastSig && host.childElementCount > 0) {
        patchInPlace(loop); // §24.2.2 S5
        return;
      }
      if (sig === lastSig) return; // both empty — nothing to do
      const restoreFocus = captureSubtreeFocus(host);
      host.replaceChildren();
      lastSig = sig;
      liveLoop = null;
      refRows = [];
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
        // The bare number renders now; the title/body/link fill in after the async gh resolve — announce
        // that late arrival to assistive tech (WCAG 4.1.3 Status Messages).
        refsEl.setAttribute('aria-live', 'polite');
        const segH = doc.createElement('div');
        segH.className = 'seg-h';
        segH.textContent = 'Working on';
        refsEl.append(segH);
        if (refs.ticket !== undefined) {
          const r = refRow('Ticket', 'issue', refs.ticket);
          refsEl.append(r.el);
          refRows.push(r);
        }
        if (refs.pr !== undefined) {
          const r = refRow('PR', 'pr', refs.pr);
          refsEl.append(r.el);
          refRows.push(r);
        }
        host.append(refsEl);
      }

      if (!loop) {
        restoreFocus(() => host.querySelector<HTMLElement>('[data-loop-close]'));
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
      // WCAG 4.1.3 — `patchInPlace` updates status/iteration here without moving focus (e.g. after the
      // mark-complete control or an orchestrator transition); a polite live region announces that change.
      ldl.setAttribute('aria-live', 'polite');
      // An awaiting-human status still needs the human — the §22.3 "act" tone (`bad`).
      const statusRow = detailRow(doc, 'status', loop.status, spillTone(loop.status) === 'await' ? 'bad' : '');
      ldl.append(statusRow);
      // No iteration row when no round has run (a §27 run-less view); the reason row then anchors on the
      // status row instead. An absent iteration is not rendered as 0 (§27 IPC item 3).
      let iterRow: HTMLElement | null = null;
      if (loop.iteration !== undefined) {
        iterRow = detailRow(doc, 'iteration', String(loop.iteration));
        ldl.append(iterRow);
      }
      const reasonAnchor = iterRow ?? statusRow;
      liveLoop = { statusVal: statusRow.querySelector('.lv')!, iterVal: iterRow?.querySelector('.lv') ?? null, ldl, reasonAnchor, body };
      // §26.3/D48 — WHY a turn stopped, adjacent to `status: error`. Present only in error (the mirror
      // clears it on recovery).
      syncReasonRow(ldl, reasonAnchor, loop.errorReason);
      if (loop.pr !== null) ldl.append(detailRow(doc, 'pr', `#${loop.pr}`, 'sig'));
      if (loop.branch !== null) ldl.append(detailRow(doc, 'branch', loop.branch));
      // The current gate's human_options (§18.1/§19.4), present only at an awaiting gate — the read-only
      // preview of what the gate offers; the actionable decision buttons render below.
      if (loop.gateOptions && loop.gateOptions.length > 0)
        ldl.append(detailRow(doc, 'gate options', loop.gateOptions.map(gateOptionLabel).join(' · ')));

      body.append(ldl);

      // §26.6 / L5 — the gate DECISION surface (loop-flow.html's approve · changes · impasse): a button
      // per gate option the def offers. Choosing one runs the LoopDef `on_*` action list in-app; the
      // decision is the app's, surfaced via state.yaml → flow:onStateChanged (the panel re-pulls). A §27
      // run-less view carries the same gateOptions display-only (loopGateActionable false) — the read-only
      // row above shows them, but no clickable control renders; the refusal guard is at the operation.
      if (loop.gateOptions && loop.gateOptions.length > 0 && loopGateActionable(loop) && deps.gateDecision) {
        const gate = doc.createElement('div');
        gate.className = 'gatebar';
        // A labelled group so a screen-reader user hears these controls' shared purpose, not three loose
        // buttons (WCAG 4.1.2). aria-label carries the group name; the row itself has no visible heading.
        gate.setAttribute('role', 'group');
        gate.setAttribute('aria-label', 'gate decision');
        for (const option of loop.gateOptions) {
          const btn = doc.createElement('button');
          // approve is the primary action (loop-flow.html) — the filled `app` tone; the rest are outline.
          btn.className = option === 'approve' ? 'pill app gate-approve' : `pill gate-${option}`;
          btn.dataset.gateOption = option;
          btn.textContent = gateOptionLabel(option);
          // The visible label stays compact ("changes"); the accessible name is the unabbreviated option
          // so AT does not announce a bare, ambiguous verb (WCAG 2.4.6; label-in-name 2.5.3).
          btn.setAttribute('aria-label', option.replace('-', ' '));
          btn.addEventListener('click', () => deps.gateDecision?.(option));
          gate.append(btn);
        }
        body.append(gate);
      }

      syncRetry(body, loop);

      // §26.3/D47a(c) — the human-in-the-loop escape hatch: advance a turn whose automatic done-signal
      // the orchestrator missed, without editing files. Present on a loop step only when the composition
      // root injects the service — an un-wired control would be an inert affordance (WCAG 4.1.2).
      if (deps.markTurnComplete) {
        const markBtn = doc.createElement('button');
        markBtn.className = 'pill mark-complete';
        markBtn.dataset.loopMarkComplete = '';
        markBtn.textContent = 'Mark turn complete';
        markBtn.addEventListener('click', () => deps.markTurnComplete?.());
        body.append(markBtn);
      }

      host.append(body);
      restoreFocus(() => host.querySelector<HTMLElement>('[data-loop-close]'));
    },
    focusDecision() {
      const action =
        host.querySelector<HTMLElement>('[data-gate-option], [data-loop-retry]') ??
        host.querySelector<HTMLElement>('[data-loop-close]');
      action?.focus();
      return action !== null;
    },
    dispose() {
      host.replaceChildren();
      lastSig = null;
      liveLoop = null;
      refRows = [];
    },
  };
}
