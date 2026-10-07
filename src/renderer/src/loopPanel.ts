// The docked loop+gate panel (§24.2.3 T2/T7) — a placement-agnostic organism (UI-STANDARDS §1.2).
// It renders two read-only sections: the ticket/PR the flow is working (T7), shown whenever the flow
// is active even on a non-loop step; and the §27 run-state view (T2) on loop steps. The ticket/PR detail
// (title, body, link) is fetched best-effort via injected services — the organism reaches for nothing itself.
//
// Scope: the run-state view + the read-only "gate options" row, plus the §27.9 gate DECISION section (a
// button per gate option, firing the injected appGateDecision with the step+turn identity it acts on, §6).
// A §27 request-changes / redo detours through its composer (composeFeedback / composeRedo).

import type { FlowLoopView, FlowRefs, GithubRef, GithubRefKind } from '../../shared/ipc';
import { hasFlowRefs } from '../../shared/ipc';
import { loopGateActionable } from '../../shared/loopGate';
import { stripDisplayControlChars } from '../../shared/controlChars';
import { githubHttpsHref } from '../../shared/githubUrl';
import { spillTone } from './loopStatus';
import { autoHaltReasonLabel } from '../../shared/gateAuthority';
import { captureSubtreeFocus } from './dom';

/** Display label for a gate `human_option` — matches loop-flow.html's "approve · changes · impasse"
 *  (the verbose `request-changes` reads as `changes` in the compact options row). The option is
 *  repo-authored, so it is stripped of display-unsafe bytes and trimmed before the comparison: a bidi
 *  override then neither defeats the abbreviation nor reaches the label derived from the result (CWE-117). */
function gateOptionLabel(option: string): string {
  const cleaned = stripDisplayControlChars(option).trim();
  if (cleaned === 'request-changes') return 'changes';
  if (cleaned === 'back-to-red') return 'Back to RED'; // §28.4.2 — a readable label, not the raw kebab option
  return cleaned;
}

/** The §24.2.3 T7 services the panel needs: resolve a ref's detail (best-effort; null → bare number)
 *  and open its url externally. Injected by the composition root; the organism never reaches for them. */
export interface LoopPanelDeps {
  githubRef(kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  openExternal(url: string): void;
  /** §27.9/§27.13 (N5) — submit the human's §27 gate decision, carrying the step+turn identity the receiver
   *  acts on (§6). A §27 gate view (one carrying `appTurn`) routes its option here. Injected by the
   *  composition root; absent → the §27 decision buttons are not rendered. */
  appGateDecision?(step: string, turnKey: string, option: string): void;
  /** §27.9/§19.4 (AC4) — open the feedback composer for a §27 request-changes at the gate. request-changes is
   *  a two-step interaction: the click opens the composer (curate a review-todo subset + free text), and the
   *  composer's submit carries the composed feedback back on the decision. Injected by the composition root;
   *  absent → the §27 request-changes button does not render (a note-less dispatch is dropped, WCAG 4.1.2). */
  composeFeedback?(step: string, turnKey: string): void;
  /** §27.9/AC5 — open the redo instruction composer for a §27 redo at the gate. Like request-changes, redo is a
   *  two-step interaction: the click opens the composer (a free-text instruction), and the composer's submit
   *  carries the instruction back on the decision. Injected by the composition root; absent → the §27 redo
   *  button does not render (an instruction-less dispatch is dropped, WCAG 4.1.2). */
  composeRedo?(step: string, turnKey: string): void;
  /** §28.4.2 — open the back-to-RED composer at the gate; its submit carries the optional slice brief. Absent →
   *  Back to RED dispatches straight to appGateDecision with no brief. */
  composeBackToRed?(step: string, turnKey: string): void;
  /** §27.12c — the §27-only work-turn route-out (retry / accept-present-artifact / terminate), carrying the
   *  step+turn identity the receiver acts on (§6). Injected by the composition root; absent → the §27 error
   *  view shows no route-out (an un-wired control would be inert, WCAG 4.1.2). */
  appRouteOut?(step: string, turnKey: string, action: 'retry' | 'accept' | 'terminate'): void;
  /** §27.9/AC9 — arm the queued interrupt for a §27 loop step, carrying the step identity it acts on (§6).
   *  Injected by the composition root; absent → no arm control renders (an un-wired control would be inert,
   *  WCAG 4.1.2). */
  armInterrupt?(step: string): void;
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
  /** Move focus onto the gate decision, the work-turn route-out, or the stable Close entry, returning
   *  whether one was there to focus. The panel owns this so a sibling never reaches into its markup for the
   *  control (§27.9 / §27.12c; WCAG 2.4.3). */
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
 *  number), so they are excluded too. The error reason is excluded because rebuilding the live region to
 *  show it would announce nothing at all (WCAG SC 4.1.3). */
function structuralSig(loop: FlowLoopView | null, title: string, refs?: FlowRefs): string {
  return JSON.stringify([
    title,
    refs?.ticket ?? null,
    refs?.pr ?? null,
    // iteration PRESENCE and actionability are structural: the iteration row and the gate-decision
    // buttons appear/disappear with them, so a run-less↔run transition forces a full render.
    // §27.9/N5 — appTurn presence decides whether the gate row renders at all (an appTurn-less view shows the
    // gate options read-only), so an appTurn↔no-appTurn transition forces a full render, not a patch.
    // §27.9/AC6 — the polish stand-down flips the gate into the polish view (a notice + approve only), a
    // structural change, so a gate↔polish transition forces a full render rather than a patch.
    loop ? [loop.pr, loop.branch, loop.gateOptions ?? null, loop.iteration !== undefined, loop.actionable ?? null, loop.appTurn !== undefined, loop.polish ?? null, loop.changedTests?.join(',') ?? null, loop.epic ? JSON.stringify(loop.epic.subTickets) : null, loop.autoGate ? [loop.autoGate.deciding, loop.autoGate.haltGeneric, loop.autoGate.haltReasons, loop.autoGate.failedEffect ?? null] : null] : null,
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

  /** §27.12 — the `reason` row. On the patch path (a status→error transition on an already-rendered view) it
   *  is added INSIDE the surviving live region so it announces as an addition (WCAG SC 4.1.3); on a first
   *  render the region is built with the row already present, so that render is silent (§K.5). `anchor` is
   *  the iteration row when a round has run, else the status row (a run-less §27 failure carries no iteration).
   *  The reason is repo-sourced, so it is stripped of display-unsafe bytes before the live region (CWE-117),
   *  above both branches so create and patch are covered alike. */
  const syncReasonRow = (ldl: HTMLElement, anchor: HTMLElement, reason: string | undefined): void => {
    const existing = ldl.querySelector<HTMLElement>('[data-loop-reason]');
    if (!reason) {
      existing?.remove();
      return;
    }
    const clean = stripDisplayControlChars(reason);
    if (existing) {
      const v = existing.querySelector('.lv')!;
      if (v.textContent !== clean) v.textContent = clean;
      return;
    }
    const row = detailRow(doc, 'reason', clean, 'bad');
    row.dataset.loopReason = '';
    anchor.after(row);
  };

  /** §27.12c — the §27 work-turn route-out: retry / accept-present-artifact / terminate. Present ONLY on a
   *  §27 error view (the view carries `appTurn` — the step+turn identity — and status `error`) so an errored
   *  §27 turn is never a UI dead-end. Each control carries the identity onto the service, so the route-out
   *  acts on the turn it names, never ambient state (§6). Service-gated: an un-wired control would be inert
   *  (WCAG 4.1.2). */
  const syncAppRouteOut = (body: HTMLElement, loop: FlowLoopView): void => {
    const existing = body.querySelector<HTMLElement>('[data-app-route-out-group]');
    if (loop.status !== 'error' || !loop.appTurn || !deps.appRouteOut) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const { step, turnKey } = loop.appTurn;
    // A display-only stripped copy for the accessible names; the dispatch keeps the RAW step, which the
    // receiver matches against persisted step identity (§6) — stripping there would dispatch an unmatchable id.
    const stepLabel = stripDisplayControlChars(step);
    const group = doc.createElement('div');
    group.className = 'gatebar';
    group.dataset.appRouteOutGroup = '';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'work turn recovery');
    const actions: Array<{ action: 'retry' | 'accept' | 'terminate'; label: string; cls: string }> = [
      { action: 'retry', label: 'Retry', cls: 'pill app' },
      { action: 'accept', label: 'Accept artifact', cls: 'pill' },
      { action: 'terminate', label: 'Terminate', cls: 'pill' },
    ];
    for (const { action, label, cls } of actions) {
      const btn = doc.createElement('button');
      btn.className = cls;
      btn.dataset.appRouteOut = action;
      btn.textContent = label;
      btn.setAttribute(
        'aria-label',
        action === 'terminate'
          ? `Terminate flow from the ${stepLabel} work turn`
          : `${label} the ${stepLabel} work turn`,
      );
      btn.addEventListener('click', () => deps.appRouteOut?.(step, turnKey, action));
      group.append(btn);
    }
    body.append(group);
  };

  /** §27.6/AC5 — the round's verdict and (only for `stop for a human`) its reason, kept INSIDE the live
   *  region so they are announced as additions when the consolidator routes to the gate (WCAG 4.1.3). Added
   *  after the reason anchor, ahead of any pr/branch rows, and removed in place when they fall away. */
  const syncVerdictRows = (ldl: HTMLElement, anchor: HTMLElement, loop: FlowLoopView): void => {
    syncNamedRow(ldl, anchor, 'loopVerdict', 'verdict', loop.verdict);
    syncNamedRow(ldl, anchor, 'loopVerdictReason', 'verdict reason', loop.verdictReason);
  };

  /** Add / update / remove a keyed detail row in `ldl`, anchored after `anchor`. `datasetKey` is the
   *  camelCase name; the matching `data-*` attribute is its kebab form. The value (verdict / verdict reason)
   *  is repo-sourced, so it is stripped of display-unsafe bytes before the live region (CWE-117), above both
   *  branches so create and patch are covered alike. */
  const syncNamedRow = (ldl: HTMLElement, anchor: HTMLElement, datasetKey: string, label: string, value: string | undefined): void => {
    const attr = `data-${datasetKey.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    const existing = ldl.querySelector<HTMLElement>(`[${attr}]`);
    if (!value) {
      existing?.remove();
      return;
    }
    const clean = stripDisplayControlChars(value);
    if (existing) {
      const v = existing.querySelector('.lv')!;
      if (v.textContent !== clean) v.textContent = clean;
      return;
    }
    const rowEl = detailRow(doc, label, clean);
    rowEl.dataset[datasetKey] = '';
    anchor.after(rowEl);
  };

  /** §27.4/§27.8/AC8 — the def's reviewer catalog with the consolidator's chosen roster distinguished within
   *  it. Rendered whenever the view carries a catalog; each persona carries `data-catalog-persona`, and one
   *  the chosen roster names carries `data-chosen="true"` (the visual treatment is the CSS's call). */
  const syncCatalog = (body: HTMLElement, loop: FlowLoopView): void => {
    const existing = body.querySelector<HTMLElement>('[data-catalog]');
    if (!loop.catalog || loop.catalog.length === 0) {
      existing?.remove();
      return;
    }
    const sig = JSON.stringify([loop.catalog, loop.chosenRoster ?? []]);
    if (existing && existing.dataset.catalogSig === sig) return; // unchanged — no rebuild, no re-announce
    const chosen = new Set(loop.chosenRoster ?? []);
    existing?.remove(); // rebuild the small list rather than diff it (catalog changes are rare and whole-set)
    const wrap = doc.createElement('div');
    wrap.className = 'catalog';
    wrap.dataset.catalog = '';
    wrap.dataset.catalogSig = sig;
    const segH = doc.createElement('div');
    segH.className = 'seg-h';
    segH.textContent = 'Reviewers';
    wrap.append(segH);
    const list = doc.createElement('ul');
    list.className = 'catalog-list';
    for (const persona of loop.catalog) {
      const li = doc.createElement('li');
      li.className = 'catalog-persona';
      li.dataset.catalogPersona = '';
      if (chosen.has(persona)) {
        li.dataset.chosen = 'true';
        // Name the "runs next round" state for assistive tech, not colour alone (WCAG 1.4.1).
        li.setAttribute('aria-label', `${persona} (runs the next round)`);
      }
      li.textContent = persona;
      list.append(li);
    }
    wrap.append(list);
    body.append(wrap);
  };

  /** §27.9/AC9 — the arm-interrupt control, offered ONLY while the loop is iterating (a live §27 working turn)
   *  and only when the service is wired (an un-wired control would be inert, WCAG 4.1.2). Fires the injected
   *  service with the step identity it acts on (§6); at the gate or in error there is nothing to interrupt, so
   *  it is removed in place. */
  const syncArmInterrupt = (body: HTMLElement, loop: FlowLoopView): void => {
    const existing = body.querySelector<HTMLElement>('[data-arm-interrupt]');
    if (loop.status !== 'working' || !loop.appTurn || !deps.armInterrupt) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const { step } = loop.appTurn;
    // A display-only stripped copy for the accessible name; the dispatch keeps the RAW step, matched against
    // persisted step identity by the receiver (§6) — stripping there would arm an unmatchable id.
    const stepLabel = stripDisplayControlChars(step);
    const btn = doc.createElement('button');
    btn.className = 'pill arm-interrupt';
    btn.dataset.armInterrupt = '';
    btn.textContent = 'Hand back to me';
    // WCAG 2.5.3 Label in Name: the accessible name must contain the visible label contiguously, so a
    // speech-input user saying "click Hand back to me" can activate it.
    btn.setAttribute('aria-label', `Hand back to me — return the ${stepLabel} loop at the next consolidation`);
    btn.addEventListener('click', () => deps.armInterrupt?.(step));
    body.append(btn);
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
      // WCAG 4.1.3 — only touch the live-region text on a real change; an unchanged passive push (refs
      // only) must not rewrite these nodes, or a screen reader re-announces content that did not change.
      if (liveLoop.statusVal.textContent !== loop.status) liveLoop.statusVal.textContent = loop.status;
      liveLoop.statusVal.classList.toggle('bad', spillTone(loop) === 'await');
      if (liveLoop.iterVal && loop.iteration !== undefined) {
        const iter = String(loop.iteration);
        if (liveLoop.iterVal.textContent !== iter) liveLoop.iterVal.textContent = iter;
      }
      syncReasonRow(liveLoop.ldl, liveLoop.reasonAnchor, loop.errorReason);
      syncVerdictRows(liveLoop.ldl, liveLoop.reasonAnchor, loop);
      syncAppRouteOut(liveLoop.body, loop);
      syncCatalog(liveLoop.body, loop);
      syncArmInterrupt(liveLoop.body, loop);
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
      segH.textContent = 'State';
      body.append(segH);

      const ldl = doc.createElement('div');
      ldl.className = 'ldl';
      // WCAG 4.1.3 — `patchInPlace` updates status/iteration here without moving focus (an orchestrator
      // transition that advances the run in place); a polite live region announces that change.
      ldl.setAttribute('aria-live', 'polite');
      // An awaiting-human status still needs the human — the §22.3 "act" tone (`bad`).
      const statusRow = detailRow(doc, 'status', loop.status, spillTone(loop) === 'await' ? 'bad' : '');
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
      // §27.12 — WHY a turn stopped, adjacent to `status: error`. Present only in error; the surviving run
      // state drops the reason on recovery.
      syncReasonRow(ldl, reasonAnchor, loop.errorReason);
      // §27.6/AC5 — the consolidator verdict + reason, adjacent to the status/iteration rows.
      syncVerdictRows(ldl, reasonAnchor, loop);
      if (loop.pr !== null) ldl.append(detailRow(doc, 'pr', `#${loop.pr}`, 'sig'));
      if (loop.branch !== null) ldl.append(detailRow(doc, 'branch', loop.branch));
      // The gate's human_options (§18.1/§19.4) — a read-only preview of what the gate offers, rendered
      // whenever the view carries gateOptions (a §27 run-less def OR the §27 terminal consolidator gate once
      // a verdict is reached); the actionable decision buttons render below (loopGateActionable + appTurn).
      if (loop.gateOptions && loop.gateOptions.length > 0)
        ldl.append(detailRow(doc, 'gate options', loop.gateOptions.map(gateOptionLabel).join(' · ')));

      body.append(ldl);

      // §27.9/AC6 — the polish stand-down: the orchestrator has released the keyboard and the operator converses
      // with the live instance directly. Surface it so the operator knows why the loop is not iterating; the
      // provider has already narrowed the gate options to approve (which ends polish), rendered below.
      if (loop.polish) {
        const notice = doc.createElement('p');
        notice.className = 'polish-notice';
        notice.dataset.polishStanddown = '';
        notice.setAttribute('role', 'status');
        notice.textContent = 'Polish mode — the orchestrator has stood down. Converse with the instance directly; approve to end polish and accept the artifact.';
        body.append(notice);
      }

      // §28.5.3/§28.8.3 — the changed-tests flag: the machine detected a test-glob file changed since the RED
      // baseline (raised by a GREEN turn or a refactor round). A NON-blocking notice (a live region) naming the
      // files, so the regression-guard persona + the human at the gate can judge legitimate correction vs weakening.
      if (loop.changedTests && loop.changedTests.length > 0) {
        const notice = doc.createElement('p');
        notice.className = 'changed-tests-notice';
        notice.dataset.changedTests = '';
        notice.setAttribute('role', 'status');
        notice.textContent = `Test file(s) changed — flagged for regression-guard: ${loop.changedTests.join(', ')}`;
        body.append(notice);
      }

      // §28.7/§27.10 — the epic split promotion will create, named for the operator before they approve. Each
      // sub-ticket is its own node so it is never announced as a bare count (WCAG 1.3.1). The title is
      // repo/agent-sourced, so it is stripped of display-unsafe bytes (CWE-117).
      if (loop.epic && loop.epic.subTickets.length > 0) {
        const section = doc.createElement('div');
        section.className = 'epic-preview';
        section.dataset.epicPreview = '';
        section.setAttribute('role', 'status'); // WCAG 4.1.3 — announce the split's appearance, like the sibling gate notices
        const segH = doc.createElement('div');
        segH.className = 'seg-h';
        segH.id = 'epic-preview-heading';
        const count = loop.epic.subTickets.length;
        segH.textContent = `Epic — ${count} sub-ticket${count === 1 ? '' : 's'}`;
        section.append(segH);
        const list = doc.createElement('ul');
        list.className = 'epic-list';
        list.setAttribute('aria-labelledby', segH.id); // WCAG 1.3.1 — the list carries its "Epic" purpose, not a bare "list, N items"
        for (const st of loop.epic.subTickets) {
          const li = doc.createElement('li');
          li.className = 'epic-subticket';
          li.dataset.epicSubticket = '';
          li.textContent = `#${st.index} — ${stripDisplayControlChars(st.title)}`;
          list.append(li);
        }
        section.append(list);
        body.append(section);
      }

      // §27.9.1 N9b.5(e)/N9b.6 — the engine deciding an `auto` gate, and every reason it halted for. Every string
      // reaches the DOM through textContent only (CWE-79): the gate's approve button sits beside it.
      if (loop.autoGate) {
        const ag = loop.autoGate;
        if (ag.deciding) {
          const notice = doc.createElement('p');
          notice.className = 'auto-deciding';
          notice.dataset.autoDeciding = '';
          notice.setAttribute('role', 'status');
          notice.textContent = 'The engine is deciding this gate — you can still decide it yourself.';
          body.append(notice);
        }
        if (ag.haltReasons.length > 0 || ag.haltGeneric) {
          const halt = doc.createElement('ul');
          halt.className = 'auto-halt';
          halt.setAttribute('aria-label', 'why this gate needs you');
          for (const { reason, detail } of ag.haltReasons) {
            const li = doc.createElement('li');
            li.dataset.autoHaltReason = reason;
            const label = autoHaltReasonLabel(reason);
            li.textContent = stripDisplayControlChars(detail === undefined ? label : `${label}: ${detail}`);
            halt.append(li);
          }
          if (ag.haltGeneric) {
            const li = doc.createElement('li');
            li.dataset.autoHaltGeneric = '';
            li.textContent = 'The engine could not approve this gate.';
            halt.append(li);
          }
          body.append(halt);
        }
        // §27.9.1 N9b.5(d)
        if (ag.failedEffect) {
          const marker = doc.createElement('p');
          marker.className = 'failed-effect';
          marker.dataset.failedEffect = ag.failedEffect.state;
          marker.setAttribute('role', 'status');
          const lead = ag.failedEffect.state === 'set' ? 'A gate side-effect failed earlier in this run' : 'A gate side-effect may have failed earlier in this run';
          marker.textContent = stripDisplayControlChars(`${lead}: ${ag.failedEffect.detail}`);
          body.append(marker);
        }
      }

      // §27.9/N5 — the gate DECISION surface (loop-flow.html's approve · changes · impasse): a button per
      // gate option the def offers, routed to appGateDecision with the step+turn identity the receiver acts
      // on (§6). The decision is the app's, surfaced through the surviving run state (the panel re-pulls).
      // §27.9/AC8 — the row is affirmative on BOTH conjuncts: it renders only when the view carries `appTurn`
      // (a decidable turn) AND appGateDecision is injected. A view carrying gateOptions but no appTurn — a
      // §27 run-less def or a display-only preview — shows the read-only row above but no clickable control,
      // because a button with no turn identity to carry would be inert (WCAG 4.1.2).
      const appTurn = loop.appTurn;
      if (appTurn && deps.appGateDecision && loop.gateOptions && loop.gateOptions.length > 0 && loopGateActionable(loop)) {
        const gate = doc.createElement('div');
        gate.className = 'gatebar';
        // A labelled group so a screen-reader user hears these controls' shared purpose, not three loose
        // buttons (WCAG 4.1.2). aria-label carries the group name; the row itself has no visible heading.
        gate.setAttribute('role', 'group');
        gate.setAttribute('aria-label', 'gate decision');
        for (const option of loop.gateOptions) {
          // §27.9/AC4 — a §27 request-changes MUST carry feedback: it is a composer-only affordance, so with no
          // composer wired render no button rather than one whose note-less dispatch the executor drops (WCAG 4.1.2).
          if (option === 'request-changes' && !deps.composeFeedback) continue;
          // §27.9/AC5 — a §27 redo MUST carry an instruction, same composer-only rule as request-changes.
          if (option === 'redo' && !deps.composeRedo) continue;
          const btn = doc.createElement('button');
          // approve is the primary action (loop-flow.html) — the filled `app` tone; every other option is
          // outline. The tone is the closed set (approve vs else), never interpolated from the raw option: a
          // space-bearing option would inject extra class tokens — affordance spoofing at the gate (§16.3).
          btn.className = option === 'approve' ? 'pill app gate-approve' : 'pill gate-option';
          btn.dataset.gateOption = option; // the RAW option — the click dispatch carries persisted identity (§6)
          const visible = gateOptionLabel(option);
          btn.textContent = visible;
          // The accessible name is derived from the STRIPPED visible label, never the raw option, so a bidi
          // override reaches neither and the name still contains the visible text (WCAG 2.5.3 label-in-name).
          // Only request-changes→changes hides its full name; every other label (incl. Back to RED) is its own name.
          btn.setAttribute('aria-label', visible === 'changes' ? 'request changes' : visible);
          btn.addEventListener('click', () => {
            // §27.9/AC4 — a §27 request-changes opens the feedback composer (its submit carries the feedback on
            // the decision); the button only renders when composeFeedback is wired (guarded above).
            if (option === 'request-changes') {
              deps.composeFeedback?.(appTurn.step, appTurn.turnKey);
              return;
            }
            // §27.9/AC5 — a §27 redo opens the instruction composer (its submit carries the instruction).
            if (option === 'redo') {
              deps.composeRedo?.(appTurn.step, appTurn.turnKey);
              return;
            }
            if (option === 'back-to-red' && deps.composeBackToRed) {
              deps.composeBackToRed(appTurn.step, appTurn.turnKey);
              return;
            }
            // The one-way options (approve, polish, §28.4.2 back-to-red) carry no human input to lose — dispatched
            // straight to appGateDecision with the step+turn identity.
            deps.appGateDecision?.(appTurn.step, appTurn.turnKey, option);
          });
          gate.append(btn);
        }
        body.append(gate);
      }

      syncAppRouteOut(body, loop);
      // §27.4/§27.9/AC8/AC9 — the reviewer catalog (chosen roster distinguished) and the arm-interrupt control.
      syncCatalog(body, loop);
      syncArmInterrupt(body, loop);

      host.append(body);
      restoreFocus(() => host.querySelector<HTMLElement>('[data-loop-close]'));
    },
    focusDecision() {
      const action =
        host.querySelector<HTMLElement>('[data-gate-option], [data-app-route-out]') ??
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
