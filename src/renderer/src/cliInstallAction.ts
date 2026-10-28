// CLI launcher install molecule (§23.5 / UI-STANDARDS): the Install action and its announcements, shared
// by the Settings view and the startup waiting card. Built from the host document; signals out only
// through the injected contract.

import type { CliInstallResult } from '../../shared/ipc';
import { onPress } from './pressable';

export interface CliInstallDeps {
  install(): Promise<CliInstallResult>;
}

export interface CliInstall {
  dispose(): void;
}

export function createCliInstallAction(host: HTMLElement, deps: CliInstallDeps): CliInstall {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'agent-terminal launcher'),
    el('div', 'kp-help', 'Adds agent-terminal to your PATH; run it like code . to open a new instance, or agent-terminal --controller to start the controller.'),
  );
  const btn = el('button', 'pill signal', 'Install');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Install the agent-terminal command-line launcher');
  card.append(txt, btn);

  const status = el('div', 'cli-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const alert = el('div', 'cli-status err');
  alert.setAttribute('role', 'alert');

  host.append(card, status, alert);

  function showStatus(cls: string, text: string): void {
    alert.textContent = '';
    status.className = cls;
    status.textContent = text;
  }
  function showError(text: string): void {
    status.className = 'cli-status';
    status.textContent = '';
    alert.textContent = text;
  }

  async function run(): Promise<void> {
    showStatus('cli-status', 'Installing…');
    try {
      const res = await deps.install();
      if (res.ok) {
        showStatus('cli-status ok', `Installed agent-terminal at ${res.path}. Open a new terminal to use it.`);
      } else {
        showError(res.error ?? 'Install failed.');
      }
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Install failed.');
    }
  }
  onPress(btn, run);

  return { dispose: () => host.replaceChildren() };
}
