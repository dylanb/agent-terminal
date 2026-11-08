// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMcpInstallAction, type McpIntegrationOutcome } from '../../src/renderer/src/mcpInstallAction';

describe('the Claude Code integration install molecule', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.replaceChildren(host);
  });

  const answering = (result: McpIntegrationOutcome) => vi.fn(async (): Promise<McpIntegrationOutcome> => result);
  const installButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Install the agent-terminal tools for Claude Code"]');
  const removeButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Remove the agent-terminal tools from Claude Code"]');
  const status = () => host.querySelector('[role="status"]')?.textContent ?? '';
  const alert = () => host.querySelector('[role="alert"]')?.textContent ?? '';

  it('installs and announces that new Claude Code sessions in agent-terminal get the tools', async () => {
    const install = answering({ ok: true });
    createMcpInstallAction(host, { install, remove: answering({ ok: true }) });
    installButton()?.click();
    await vi.waitFor(() => expect(status()).toMatch(/installed/i));
    expect(install).toHaveBeenCalledTimes(1);
    expect(alert()).toBe('');
  });

  it('removes and announces it', async () => {
    const remove = answering({ ok: true });
    createMcpInstallAction(host, { install: answering({ ok: true }), remove });
    removeButton()?.click();
    await vi.waitFor(() => expect(status()).toMatch(/removed/i));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('announces a failed install with its reason through the alert region, never as success', async () => {
    createMcpInstallAction(host, { install: answering({ ok: false, error: 'settings.json is not valid JSON' }), remove: answering({ ok: true }) });
    installButton()?.click();
    await vi.waitFor(() => expect({ alert: alert(), saysInstalled: /installed/i.test(status()) }).toEqual({ alert: expect.stringContaining('settings.json is not valid JSON'), saysInstalled: false }));
  });

  it('announces an install that throws with its reason through the alert region, never as success', async () => {
    const install = vi.fn(async (): Promise<McpIntegrationOutcome> => {
      throw new Error('the install handler crashed');
    });
    createMcpInstallAction(host, { install, remove: answering({ ok: true }) });
    installButton()?.click();
    await vi.waitFor(() => expect({ alert: alert(), saysInstalled: /installed/i.test(status()) }).toEqual({ alert: expect.stringContaining('the install handler crashed'), saysInstalled: false }));
  });

  it('announces a failed remove with its reason, and the action can be tried again', async () => {
    const remove = vi.fn<() => Promise<McpIntegrationOutcome>>().mockResolvedValueOnce({ ok: false, error: 'no claude found' }).mockResolvedValueOnce({ ok: true });
    createMcpInstallAction(host, { install: answering({ ok: true }), remove });
    removeButton()?.click();
    await vi.waitFor(() => expect(alert()).toContain('no claude found'));
    removeButton()?.click();
    await vi.waitFor(() => expect(status()).toMatch(/removed/i));
    expect(alert()).toBe('');
  });

  it('starts neither action while the other is pending', () => {
    let settle: (result: McpIntegrationOutcome) => void = () => undefined;
    const install = vi.fn(() => new Promise<McpIntegrationOutcome>((resolve) => (settle = resolve)));
    const remove = answering({ ok: true });
    createMcpInstallAction(host, { install, remove });
    installButton()?.click();
    removeButton()?.click();
    const whilePending = { removeRan: remove.mock.calls.length, install: installButton()?.getAttribute('aria-disabled'), remove: removeButton()?.getAttribute('aria-disabled') };
    settle({ ok: true });
    expect(whilePending).toEqual({ removeRan: 0, install: 'true', remove: 'true' });
  });

  it('renders only into its host', () => {
    const sibling = document.createElement('div');
    document.body.append(sibling);
    createMcpInstallAction(host, { install: answering({ ok: true }), remove: answering({ ok: true }) });
    expect({ body: [...document.body.childNodes], sibling: sibling.childNodes.length, host: host.childNodes.length > 0 }).toEqual({ body: [host, sibling], sibling: 0, host: true });
  });
});
