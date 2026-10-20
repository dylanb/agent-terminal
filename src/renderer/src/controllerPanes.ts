import type { ControllerApi } from '../../shared/ipc';

export function createControllerPanes(host: HTMLElement, deps: { controller: ControllerApi }): { dispose(): void } {
  let disposed = false;
  const unsubscribe = deps.controller.subscribeTerminals(terminals => {
    const announce = () => {
      if (disposed) return;
      let alert = host.querySelector('[role="alert"]');
      if (!alert) {
        alert = document.createElement('p');
        alert.setAttribute('role', 'alert');
        host.append(alert);
      }
      alert.textContent = 'Terminal unavailable';
    };
    host.replaceChildren(...terminals.map(terminal => {
      const button = document.createElement('button');
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
      host.append(empty);
    }
  });
  return { dispose() { disposed = true; unsubscribe(); host.replaceChildren(); } };
}
