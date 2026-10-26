// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCliInstallAction } from '../../src/renderer/src/cliInstallAction';
import type { CliInstallResult } from '../../src/shared/ipc';

describe('cli install action molecule (§23.5)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  const install = (result: CliInstallResult) => vi.fn(async (): Promise<CliInstallResult> => result);
  const button = (): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Install the agent-terminal command-line launcher"]');

  it('tells the user the installed command can start the controller', () => {
    createCliInstallAction(host, { install: install({ ok: true, path: '/p/agent-terminal' }) });
    expect(host.textContent).toContain('agent-terminal --controller');
  });

  it('installs and announces the installed path', async () => {
    const run = install({ ok: true, path: '/p/agent-terminal' });
    createCliInstallAction(host, { install: run });
    button()!.click();
    await vi.waitFor(() =>
      expect(host.querySelector('[role="status"]')?.textContent).toContain('Installed agent-terminal at /p/agent-terminal'),
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('announces a failed install through the alert region, never as success', async () => {
    createCliInstallAction(host, { install: install({ ok: false, error: 'no writable PATH directory' }) });
    button()!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('no writable PATH directory'));
    expect(host.querySelector('[role="status"]')?.textContent).not.toContain('Installed');
  });

  it('renders only into its host', () => {
    const sibling = document.createElement('div');
    document.body.append(sibling);
    createCliInstallAction(host, { install: install({ ok: true, path: '/p' }) });
    expect(sibling.childNodes).toHaveLength(0);
  });
});
