// CLI launcher install VIEW organism (§23.4 / UI-STANDARDS): the Settings section around the install
// action. Built from the host document so it stays relocatable; signals out only through the injected
// contract.

import { createCliInstallAction, type CliInstall, type CliInstallDeps } from './cliInstallAction';

export type { CliInstall, CliInstallDeps };

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
  root.append(head);
  host.appendChild(root);
  createCliInstallAction(root, deps);

  return { dispose: () => host.replaceChildren() };
}
