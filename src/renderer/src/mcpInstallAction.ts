// Claude Code integration install molecule (UI-STANDARDS): the Install and Remove actions and their announcements in
// the Settings view. Built from the host document; signals out only through the injected contract.

export type McpIntegrationOutcome = { ok: true } | { ok: false; error: string };

export interface McpInstallDeps {
  install(): Promise<McpIntegrationOutcome>;
  remove(): Promise<McpIntegrationOutcome>;
}

export interface McpInstall {
  dispose(): void;
}

export function createMcpInstallAction(host: HTMLElement, _deps: McpInstallDeps): McpInstall {
  const doc = host.ownerDocument;
  const button = (label: string, name: string): HTMLButtonElement => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pill';
    btn.textContent = label;
    btn.setAttribute('aria-label', name);
    return btn;
  };
  const status = doc.createElement('div');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const alert = doc.createElement('div');
  alert.setAttribute('role', 'alert');
  host.append(
    button('Install', 'Install the agent-terminal tools for Claude Code'),
    button('Remove', 'Remove the agent-terminal tools from Claude Code'),
    status,
    alert,
  );
  return { dispose: () => host.replaceChildren() };
}
