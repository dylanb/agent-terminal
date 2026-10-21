// §27.13 v2.211 — the operator's confirm of a held run's ticket and pull request: a status line with a way back
// into the dialog, and the blocking dialog itself (UI-STANDARDS §5) the app raises on its own.

import type { ConfirmRunPickupResult, PickupConfirmView, RunRef } from '../../shared/ipc';
import type { FlowViewArgs } from './flowView';
import { createModalShell } from './modalShell';

type Proposed = Extract<PickupConfirmView, { state: 'proposed' }>;

export interface PickupConfirmDeps {
  modalHost: HTMLElement;
  onView(cb: (...args: FlowViewArgs) => void): () => void;
  confirm(repoKey: string, run: RunRef, pr: number, ticket: number): Promise<ConfirmRunPickupResult>;
  onFocusLost?: () => void;
}

export interface PickupConfirm {
  dispose(): void;
}

const runKey = (repoKey: string, run: RunRef): string => `${repoKey}\u0000${run.flow}\u0000${run.startedAt}`;
const parseNumber = (text: string): number | null => (/^\d+$/.test(text.trim()) && Number(text) > 0 ? Number(text) : null);

export function createPickupConfirm(host: HTMLElement, deps: PickupConfirmDeps): PickupConfirm {
  const doc = host.ownerDocument;
  const shell = createModalShell(deps.modalHost, 'pickup-confirm-title', undefined, { role: 'alertdialog', onFocusLost: deps.onFocusLost });
  const offered = new Set<string>();
  let openFor: string | null = null;

  const closeDialog = (): void => {
    openFor = null;
    shell.render(null);
  };

  const openDialog = (repoKey: string, held: Proposed, opener: HTMLElement | null): void => {
    openFor = runKey(repoKey, held.run);
    shell.render(({ doc: d, titleId, close, confirm: accept }) => {
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
          : `This run is past its pickup, but the app has no saved pull request for it. This is what it found for ${held.branch}. Nothing in the run continues until you confirm, or correct, these.`;
      body.append(ph);
      if (held.problems.length > 0) {
        const list = d.createElement('ul');
        list.className = 'cd-resources';
        for (const problem of held.problems) {
          const item = d.createElement('li');
          item.textContent = problem;
          list.append(item);
        }
        body.append(list);
      }
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
      const prInput = numberField('Pull request', held.pr);
      const ticketInput = numberField('Ticket', held.ticket);
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
      later.addEventListener('click', () => {
        openFor = null;
        close();
      });
      const ok = d.createElement('button');
      ok.className = 'pill signal confirm';
      ok.textContent = 'Confirm';
      ok.addEventListener('click', () => {
        const pr = parseNumber(prInput.value);
        const ticket = parseNumber(ticketInput.value);
        if (pr === null || ticket === null) {
          error.textContent = 'Enter the pull request and ticket as numbers.';
          return;
        }
        error.textContent = '';
        ok.disabled = true;
        void deps.confirm(repoKey, held.run, pr, ticket).then((result) => {
          ok.disabled = false;
          if (result.ok) {
            openFor = null;
            accept();
          } else {
            error.textContent = result.reason;
          }
        });
      });
      foot.append(later, ok);
      card.append(foot);
      return { card, initialFocus: (held.pr === null ? prInput : ok) as HTMLElement, describedById, grow: body, scroll: body, role: 'alertdialog' };
    }, opener);
  };

  const render = (...[repoKey, view]: FlowViewArgs): void => {
    host.replaceChildren();
    const held = view?.pickupConfirm;
    if (repoKey === null || held === undefined) {
      if (openFor !== null) closeDialog();
      return;
    }
    const key = runKey(repoKey, held.run);
    if (openFor !== null && openFor !== key) closeDialog();
    const status = doc.createElement('p');
    status.className = 'ph';
    if (held.state === 'looking') {
      status.textContent = 'Looking up this run’s ticket and pull request…';
      host.append(status);
      return;
    }
    status.textContent = 'This run is waiting for you to confirm its ticket and pull request.';
    const reopen = doc.createElement('button');
    reopen.className = 'pill';
    reopen.textContent = 'Confirm ticket and PR…';
    reopen.setAttribute('aria-haspopup', 'dialog');
    reopen.addEventListener('click', () => openDialog(repoKey, held, reopen));
    host.append(status, reopen);
    if (!offered.has(key)) {
      offered.add(key);
      openDialog(repoKey, held, null);
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
