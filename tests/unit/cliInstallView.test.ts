// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCliInstall, type CliInstallDeps } from '../../src/renderer/src/cliInstall';
import type { CliInstallResult } from '../../src/shared/ipc';

// CLI launcher install VIEW organism (§23.4 / UI-STANDARDS): one Install action that announces success
// or a visible error. Tests assert the observable DOM + the injected contract callback, never internals.
describe('cli install view organism (§23.4)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  const deps = (over: Partial<CliInstallDeps> = {}): CliInstallDeps => ({
    install: vi.fn(async (): Promise<CliInstallResult> => ({ ok: true, path: '/home/u/.agent-terminal/bin/agent-terminal' })),
    ...over,
  });
  const button = (): HTMLButtonElement => host.querySelector('button') as HTMLButtonElement;
  const status = (): HTMLElement => host.querySelector('[role="status"]') as HTMLElement;

  it('renders an install button and a status live region', () => {
    createCliInstall(host, deps());
    expect(button()).toBeTruthy();
    expect(status()).toBeTruthy();
    expect(status().getAttribute('aria-live')).toBe('polite');
  });

  it('invokes the install action and announces success with the installed path', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: true, path: '/p/agent-terminal' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(status().textContent).toContain('/p/agent-terminal'));
  });

  it('announces a visible error when the install fails', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: false, error: 'no writable PATH directory' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(status().textContent).toContain('no writable PATH directory'));
  });

  it('does not announce success when the install fails', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: false, error: 'boom' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(status().textContent).toContain('boom'));
    expect(status().className).not.toMatch(/\bok\b/);
  });

  it('announces a visible error when the install action throws', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => { throw new Error('ipc unavailable'); });
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(status().textContent).toContain('ipc unavailable'));
    expect(status().className).not.toMatch(/\bok\b/);
  });

  it('re-enables the button after an install completes so a retry is possible', async () => {
    let resolveInstall: (r: CliInstallResult) => void = () => {};
    const install = vi.fn(() => new Promise<CliInstallResult>((r) => { resolveInstall = r; }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(button().disabled).toBe(true));
    resolveInstall({ ok: true, path: '/p/agent-terminal' });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });
});
