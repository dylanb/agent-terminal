// §27.13 — the operator's confirm of a held run's ticket and pull request: a status line with a way back
// into the dialog, and the blocking dialog itself (UI-STANDARDS §5) the app raises on its own.

import type { ConfirmRunPickupResult, PickupConfirmView } from '../../shared/ipc';
import { runKeyOf, type RunIdentity } from '../../shared/runIdentity';
import type { FlowViewArgs } from './flowView';
import { createModalShell } from './modalShell';
import { captureFocusReturn, captureSubtreeFocus } from './dom';
import { onPress } from './pressable';

type Proposed = Extract<PickupConfirmView, { state: 'proposed' }>;

export interface PickupConfirmDeps {
  modalHost: HTMLElement;
  onView(cb: (...args: FlowViewArgs) => void): () => void;
  confirm(repoKey: string, run: RunIdentity, pr: number, ticket: number): Promise<ConfirmRunPickupResult>;
  onFocusLost?: () => void;
}

export interface PickupConfirm {
  dispose(): void;
}

const runKey = (repoKey: string, run: RunIdentity): string => JSON.stringify([repoKey, runKeyOf(run)]);
const parseNumber = (text: string): number | null => {
  const n = /^\d+$/.test(text.trim()) ? Number(text) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function createPickupConfirm(host: HTMLElement, deps: PickupConfirmDeps): PickupConfirm {
  const doc = host.ownerDocument;
  const shell = createModalShell(deps.modalHost, 'pickup-confirm-title', undefined, { role: 'alertdialog', onFocusLost: deps.onFocusLost });
  const offered = new Set<string>();
  let openFor: string | null = null;

  const closeDialog = (): void => {
    openFor = null;
    shell.render(null);
  };

  /** `opener` is the control that opened it; the app's own raise returns focus to wherever the operator was. */
  const openDialog = (repoKey: string, held: Proposed, opener?: HTMLElement): void => {
    openFor = runKey(repoKey, held.run);
    shell.render(({ doc: d, titleId, close, confirm: accept, presses: footer }) => {
      const describedById = `${titleId}-desc`;
      const card = d.createElement('div');
      card.className = 'card';
      const h3 = d.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = 'Confirm this run’s ticket and pull request';
      const body = d.createElement('div');
      const ph = d.createElement('p');
      ph.className = 'ph';
      ph.id = describedById;
      ph.textContent =
        held.branch === null
          ? 'This run is past its pickup, but the app has no saved pull request for it and no branch is checked out. Nothing in the run continues until you confirm its ticket and pull request.'
          : `This run is past its pickup, but the app has no saved pull request for it. This is what it found for ${held.branch}. Nothing in the run continues until you confirm${held.adopted === undefined ? ', or correct,' : ''} these.`;
      body.append(ph);
      let describedBy = describedById;
      if (held.problems.length > 0) {
        const list = d.createElement('ul');
        list.className = 'cd-resources';
        list.id = `${titleId}-problems`;
        describedBy = `${describedById} ${list.id}`;
        for (const problem of held.problems) {
          const item = d.createElement('li');
          item.textContent = problem;
          list.append(item);
        }
        body.append(list);
      }
      const readOnlyField = (parent: HTMLElement, label: string, value: string): void => {
        const field = d.createElement('div');
        field.className = 'field';
        const lab = d.createElement('div');
        lab.className = 'flab';
        const nm = d.createElement('span');
        nm.className = 'nm';
        nm.textContent = label;
        lab.append(nm);
        const text = d.createElement('p');
        text.className = 'ph';
        text.textContent = value;
        field.append(lab, text);
        parent.append(field);
      };
      const numberField = (label: string, value: number | null): HTMLInputElement => {
        const field = d.createElement('div');
        field.className = 'field';
        const lab = d.createElement('div');
        lab.className = 'flab';
        const nm = d.createElement('span');
        nm.className = 'nm';
        nm.textContent = label;
        lab.append(nm);
        const input = d.createElement('input');
        input.setAttribute('aria-label', label);
        input.inputMode = 'numeric';
        input.value = value === null ? '' : String(value);
        field.append(lab, input);
        body.append(field);
        return input;
      };
      const { adopted } = held;
      let numbers: () => { pr: number | null; ticket: number | null } | string;
      let initialInput: HTMLInputElement | null = null;
      if (adopted === undefined) {
        const prInput = numberField('Pull request', held.pr);
        const ticketInput = numberField('Ticket', held.ticket);
        initialInput = prInput;
        numbers = () => ({ pr: parseNumber(prInput.value), ticket: parseNumber(ticketInput.value) });
      } else {
        const values = d.createElement('div');
        values.id = `${titleId}-values`;
        readOnlyField(values, 'Pull request', held.pr === null ? 'unknown' : `#${held.pr}`);
        readOnlyField(values, 'Primary ticket', adopted.recoverable ? `${adopted.primary.repo}#${adopted.primary.number}` : 'cannot be recovered');
        body.append(values);
        describedBy = `${describedBy} ${values.id}`;
        numbers = () => (adopted.recoverable ? { pr: held.pr, ticket: adopted.primary.number } : adopted.reason);
      }
      const error = d.createElement('p');
      error.className = 'ph';
      error.setAttribute('role', 'alert');
      body.append(error);
      card.append(h3, body);

      const foot = d.createElement('div');
      foot.className = 'mfoot';
      const later = d.createElement('button');
      later.className = 'pill cancel';
      later.textContent = 'Not now';
      const ok = d.createElement('button');
      ok.className = 'pill signal confirm';
      ok.textContent = 'Confirm';
      footer.bind(later, () => {
        openFor = null;
        close();
      });
      footer.bind(ok, () => {
        const picked = numbers();
        if (typeof picked === 'string') {
          error.textContent = picked;
          return;
        }
        const { pr, ticket } = picked;
        if (pr === null || ticket === null) {
          error.textContent = 'Enter the pull request and ticket as numbers.';
          return;
        }
        error.textContent = '';
        const returnFocus = captureFocusReturn(ok);
        const refused = (reason: string): void => {
          error.textContent = reason;
          returnFocus();
        };
        return deps.confirm(repoKey, held.run, pr, ticket).then(
          (result) => {
            if (!result.ok) return refused(result.reason);
            openFor = null;
            accept();
          },
          (e: unknown) => refused(e instanceof Error ? e.message : String(e)),
        );
      });
      foot.append(later, ok);
      card.append(foot);
      const initialFocus = initialInput !== null && (held.pr === null || held.problems.length > 0) ? initialInput : ok;
      return { card, initialFocus, describedById: describedBy, grow: body, scroll: body, role: 'alertdialog' };
    }, opener);
  };

  // WCAG 2.4.3
  let shown: { repoKey: string; held: Proposed } | null = null;
  const reopen = doc.createElement('button');
  reopen.className = 'pill';
  reopen.textContent = 'Confirm ticket and PR…';
  reopen.setAttribute('aria-haspopup', 'dialog');
  onPress(reopen, () => {
    if (shown !== null) openDialog(shown.repoKey, shown.held, reopen);
  });

  /** Empties the host when no run is held, handing focus to `onFocusLost` if it was on the line (UI §4.5). */
  const render = (...[repoKey, view]: FlowViewArgs): void => {
    const focusWasHere = host.contains(doc.activeElement);
    const restoreFocus = captureSubtreeFocus(host);
    host.replaceChildren();
    const held = view?.pickupConfirm;
    if (repoKey === null || held === undefined) {
      if (openFor !== null) closeDialog();
      if (focusWasHere) deps.onFocusLost?.();
      return;
    }
    const key = runKey(repoKey, held.run);
    if (openFor !== null && openFor !== key) closeDialog();
    const status = doc.createElement('p');
    status.className = 'ph';
    if (held.state === 'looking') {
      status.textContent = 'Looking up this run’s ticket and pull request…';
      host.append(status);
      if (focusWasHere) deps.onFocusLost?.();
      return;
    }
    status.textContent = 'This run is waiting for you to confirm its ticket and pull request.';
    shown = { repoKey, held };
    host.append(status, reopen);
    restoreFocus(() => reopen);
    if (!offered.has(key)) {
      offered.add(key);
      openDialog(repoKey, held);
    }
  };

  const off = deps.onView(render);
  return {
    dispose() {
      off();
      shell.dispose();
      host.replaceChildren();
    },
  };
}
