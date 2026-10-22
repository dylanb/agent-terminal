import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import { captureSubtreeFocus } from './dom';
import type { ControllerApi, ControllerWorkStatus } from '../../shared/ipc';

function workDetails(work?: ControllerWorkStatus): HTMLElement {
  const details = document.createElement('span');
  details.className = 'controller-work';
  const label = (text: string, tone = '') => {
    const element = document.createElement('span');
    element.className = tone;
    element.textContent = text;
    details.append(element);
    return element;
  };
  if (!work) {
    label('Work loading');
    return details;
  }
  if (work.unavailableReason) {
    label(CONTROLLER_OVERSIZED_STATUS_TEXT, 'controller-attention');
    return details;
  }
  if (work.flow.availability === 'known') {
    label(work.flow.assignment, `controller-assignment-${work.flow.assignment}`);
    label(`Flow: ${work.flow.name} — Step: ${work.flow.step}`);
  } else label(`Flow ${work.flow.availability}`);
  if (work.ticket.availability === 'known') {
    const ticket = label('', 'controller-ticket');
    const number = document.createElement('span');
    number.textContent = `#${work.ticket.number}`;
    const title = document.createElement('span');
    title.className = 'controller-ticket-title';
    title.textContent = work.ticket.title.availability === 'known' ? work.ticket.title.text : `Title ${work.ticket.title.availability}`;
    ticket.append(number, title);
  } else label(work.ticket.availability === 'none' ? 'No ticket' : `Ticket ${work.ticket.availability}`);
  label(work.activity === 'quiet' ? 'Idle' : work.activity === 'active' ? 'Active' : 'Activity unavailable', `controller-activity-${work.activity}`);
  if (work.attention) {
    label(`Human needed: ${work.attention.status}`, 'controller-attention');
    for (const reason of work.attention.reasons) label(reason, 'controller-attention');
  }
  if (work.error) label(`Error: ${work.error.reason}`, 'controller-error');
  return details;
}

export function createControllerPanes(host: HTMLElement, deps: { controller: ControllerApi }): { dispose(): void } {
  let disposed = false;
  host.classList.add('controller-panes');
  const list = document.createElement('div');
  list.className = 'controller-pane-list';
  const alert = document.createElement('p');
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  const status = document.createElement('p');
  status.className = 'controller-status-announcement';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-atomic', 'true');
  let previousAttention = new Map<string, string>();
  host.append(list, alert, status);
  const unsubscribe = deps.controller.subscribeTerminals(terminals => {
    const currentAttention = new Map<string, string>();
    const announcements: string[] = [];
    for (const terminal of terminals) {
      if (terminal.status === 'disconnected') continue;
      const work = terminal.work;
      const text = work?.unavailableReason ? CONTROLLER_OVERSIZED_STATUS_TEXT : [
        ...(work?.attention ? [`Human needed: ${work.attention.status}`, ...work.attention.reasons] : []),
        ...(work?.error ? [`Error: ${work.error.reason}`] : []),
      ].join('. ');
      currentAttention.set(terminal.id, text);
      if (text !== (previousAttention.get(terminal.id) ?? '')) {
        announcements.push(`${terminal.launchDirectory}: ${text || (previousAttention.get(terminal.id) === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared')}`);
      }
    }
    if (announcements.length || [...previousAttention.keys()].some(id => !currentAttention.has(id))) {
      status.textContent = announcements.join('\n');
    }
    previousAttention = currentAttention;
    const announce = () => {
      if (disposed) return;
      alert.replaceChildren();
      alert.textContent = 'Terminal unavailable';
    };
    const restoreFocus = captureSubtreeFocus(list);
    const focusedId = (host.ownerDocument.activeElement as HTMLElement | null)?.dataset.terminalId;
    list.replaceChildren(...terminals.map(terminal => {
      if (terminal.status === 'disconnected') {
        const description = document.createElement('p');
        description.className = 'controller-disconnected';
        description.dataset.terminalId = terminal.id;
        description.tabIndex = -1;
        description.textContent = terminal.launchDirectory + (terminal.repositoryRoot ? ` Repository: ${terminal.repositoryRoot}` : '') + ' — Disconnected: terminal unavailable';
        const pane = document.createElement('div');
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.dataset.terminalId = terminal.id;
        dismiss.textContent = 'Dismiss';
        dismiss.setAttribute('aria-label', `Dismiss disconnected terminal ${terminal.launchDirectory}`);
        dismiss.addEventListener('click', () => {
          void deps.controller.dismissTerminal(terminal.id).catch(announce);
        });
        pane.append(description, dismiss);
        return pane;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.terminalId = terminal.id;
      button.textContent = terminal.launchDirectory + (terminal.repositoryRoot ? ` Repository: ${terminal.repositoryRoot}` : '');
      button.append(workDetails(terminal.work));
      button.addEventListener('click', () => {
        void deps.controller.activateTerminal(terminal.id).then(outcome => {
          if (outcome === 'unavailable') announce();
        }, announce);
      });
      return button;
    }));
    if (!terminals.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No terminals connected. Launch a terminal while the controller is running.';
      empty.tabIndex = -1;
      list.append(empty);
    }
    restoreFocus(() => [...list.querySelectorAll<HTMLButtonElement>('button[data-terminal-id]')].find(element => element.dataset.terminalId === focusedId) ?? list.querySelector('button') ?? list.querySelector('p'));
  });
  return { dispose() { disposed = true; unsubscribe(); host.replaceChildren(); host.classList.remove('controller-panes'); } };
}
