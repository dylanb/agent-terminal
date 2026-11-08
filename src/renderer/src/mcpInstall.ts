// Claude Code tools VIEW organism (UI-STANDARDS): the Settings section around the install and remove actions. Built
// from the host document so it stays relocatable; signals out only through the injected contract.

import { createMcpInstallAction, type McpInstall, type McpInstallDeps } from './mcpInstallAction';

export function createMcpInstall(host: HTMLElement, deps: McpInstallDeps): McpInstall {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const root = el('div', 'kview mcp-install');
  const head = el('div', 'kview-head');
  head.append(
    el('div', 'eyebrow', 'Settings'),
    el('h1', 'serif', 'Claude Code'),
    el('div', 'sub', 'Give Claude Code sessions in agent-terminal tools to read and operate their own window.'),
  );
  root.append(head);
  host.appendChild(root);
  createMcpInstallAction(root, deps);
  return { dispose: () => host.replaceChildren() };
}
