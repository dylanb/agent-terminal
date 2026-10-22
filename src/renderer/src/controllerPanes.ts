import { captureSubtreeFocus } from './dom';
import type { ControllerApi } from '../../shared/ipc';

export function createControllerPanes(host: HTMLElement, deps: { controller: ControllerApi }): { dispose(): void } {
  let disposed = false;
  host.classList.add('controller-panes');
  const list = document.createElement('div');
  list.className = 'controller-pane-list';
  const alert = document.createElement('p');
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  host.append(list, alert);
  const unsubscribe = deps.controller.subscribeTerminals(terminals => {
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
