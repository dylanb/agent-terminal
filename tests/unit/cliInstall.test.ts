// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCliInstall, type CliInstallDeps } from '../../src/renderer/src/cliInstall';
import { assertRendersFromHostDocument } from './relocatable';
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
  const alert = (): HTMLElement | null => host.querySelector('[role="alert"]');

  it('renders an install button and a status live region', () => {
    createCliInstall(host, deps());
    expect(button()).toBeTruthy();
    expect(status()).toBeTruthy();
    expect(status().getAttribute('aria-live')).toBe('polite');
  });

  it('titles its section with a level-2 heading, not a second page-level h1 (WCAG 1.3.1)', () => {
    createCliInstall(host, deps());
    expect(host.querySelector('h1')).toBeNull();
    expect(host.querySelector('h2')?.textContent).toBe('Command line');
  });

  it('keeps the assertive alert region in the accessibility tree from initial render (WAI-ARIA 6.3.3)', () => {
    createCliInstall(host, deps());
    const a = alert() as HTMLElement;
    expect(a).toBeTruthy();
    expect(a.style.display).not.toBe('none');
  });

  it('keeps the alert region present (not display:none) while announcing an install failure', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: false, error: 'no writable PATH directory' }));
    createCliInstall(host, deps({ install }));
    const a = alert() as HTMLElement;
    button().click();
    await vi.waitFor(() => expect(a.textContent).toContain('no writable PATH directory'));
    expect(a.style.display).not.toBe('none');
  });

  it('invokes the install action and announces success with the installed path', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: true, path: '/p/agent-terminal' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(install).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(status().textContent).toContain('/p/agent-terminal'));
  });

  it('announces install failures through an assertive alert region (WCAG 4.1.3)', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: false, error: 'no writable PATH directory' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('no writable PATH directory'));
  });

  it('does not announce success when the install fails', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => ({ ok: false, error: 'boom' }));
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('boom'));
    expect(status().className).not.toMatch(/\bok\b/);
  });

  it('routes a thrown install error through the assertive alert region', async () => {
    const install = vi.fn(async (): Promise<CliInstallResult> => { throw new Error('ipc unavailable'); });
    createCliInstall(host, deps({ install }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('ipc unavailable'));
    expect(status().className).not.toMatch(/\bok\b/);
  });

  it('keeps the assertive alert region empty on a successful install', async () => {
    createCliInstall(host, deps());
    button().click();
    await vi.waitFor(() => expect(status().textContent).toContain('Installed'));
    expect(alert()?.textContent ?? '').toBe('');
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

  it('builds its DOM from the host document, not the ambient global (relocatable, §3.3)', async () => {
    await assertRendersFromHostDocument((h) => { createCliInstall(h, deps()); });
  });

  it('renders identically across two host placements (relocation, §3.3)', () => {
    const a = document.createElement('section');
    const b = document.createElement('aside');
    document.body.append(a, b);
    createCliInstall(a, deps());
    createCliInstall(b, deps());
    const shape = (h: HTMLElement) => ({
      buttons: h.querySelectorAll('button').length,
      status: h.querySelectorAll('[role="status"]').length,
      alert: h.querySelectorAll('[role="alert"]').length,
    });
    expect(shape(a)).toEqual(shape(b));
    expect(shape(a).buttons).toBe(1);
    expect(shape(a).status).toBe(1);
    expect(shape(a).alert).toBe(1);
  });
});
