// Claude Code integration install molecule (UI-STANDARDS): the Install and Remove actions and their announcements in
// the Settings view. Built from the host document; signals out only through the injected contract.

import type { ClaudeCodeIntegrationResult } from '../../shared/ipc';
import { createPressGroup } from './pressable';

export type McpIntegrationOutcome = ClaudeCodeIntegrationResult;

export interface McpInstallDeps {
  install(): Promise<McpIntegrationOutcome>;
  remove(): Promise<McpIntegrationOutcome>;
}

export interface McpInstall {
  dispose(): void;
}

export function createMcpInstallAction(host: HTMLElement, deps: McpInstallDeps): McpInstall {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (label: string, name: string): HTMLButtonElement => {
    const btn = el('button', 'pill', label);
    btn.type = 'button';
    btn.setAttribute('aria-label', name);
    return btn;
  };

  const card = el('div', 'kprofile');
  const txt = el('div');
  txt.append(
    el('div', 'kp-label', 'Claude Code tools'),
    el('div', 'kp-help', "Lets Claude Code sessions in agent-terminal read and operate their own window. Adds an agent-terminal MCP server and hooks to your Claude Code configuration; sessions outside agent-terminal see no tools."),
  );
  const install = button('Install', 'Install the agent-terminal tools for Claude Code');
  const remove = button('Remove', 'Remove the agent-terminal tools from Claude Code');
  card.append(txt, install, remove);

  const status = el('div', 'cli-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const alert = el('div', 'cli-status err');
  alert.setAttribute('role', 'alert');
  host.append(card, status, alert);

  const showStatus = (cls: string, text: string): void => {
    alert.textContent = '';
    status.className = cls;
    status.textContent = text;
  };
  const showError = (text: string): void => {
    status.className = 'cli-status';
    status.textContent = '';
    alert.textContent = text;
  };

  const run = (action: () => Promise<McpIntegrationOutcome>, pending: string, done: string, failed: string) => async (): Promise<void> => {
    showStatus('cli-status', pending);
    try {
      const result = await action();
      if (result.ok) showStatus('cli-status ok', done);
      else showError(result.error || failed);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      showError(reason || failed);
    }
  };

  const controls = createPressGroup();
  controls.bind(install, run(() => deps.install(), 'Installing…', 'Installed. New Claude Code sessions in agent-terminal list the agent-terminal tools.', 'Install failed.'));
  controls.bind(remove, run(() => deps.remove(), 'Removing…', 'Removed. New Claude Code sessions no longer list the agent-terminal tools.', 'Remove failed.'));

  return { dispose: () => host.replaceChildren() };
}
