// CLI launcher install VIEW organism (§23.4 / UI-STANDARDS): a single Install action that puts the
// agent-terminal command on PATH and announces success or a visible error. Built from the host
// document so it stays relocatable; signals out only through the injected contract.

import type { CliInstallResult } from '../../shared/ipc';

export interface CliInstallDeps {
  install(): Promise<CliInstallResult>;
}

export interface CliInstall {
  dispose(): void;
}

export function createCliInstall(host: HTMLElement, deps: CliInstallDeps): CliInstall {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const root = el('div', 'kview cli-install');
  const head = el('div', 'kview-head');
  head.append(
    el('div', 'eyebrow', 'Settings'),
    el('h1', 'serif', 'Command line'),
    el('div', 'sub', 'Install the agent-terminal command so you can open a new instance rooted at any directory from your shell.'),
  );

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'agent-terminal launcher'),
    el('div', 'kp-help', 'Adds agent-terminal to your PATH; run it like code . to open a new instance.'),
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

  root.append(head, card, status, alert);
  host.appendChild(root);

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

  let busy = false;
  async function run(): Promise<void> {
    if (busy) return;
    busy = true;
    btn.disabled = true;
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
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }
  btn.addEventListener('click', () => void run());

  return { dispose: () => host.replaceChildren() };
}
