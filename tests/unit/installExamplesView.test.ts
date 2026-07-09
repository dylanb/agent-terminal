// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInstallExamples, type InstallExamplesDeps } from '../../src/renderer/src/installExamples';
import { assertRendersFromHostDocument } from './relocatable';
import type { InstallExamplesPreview, InstallExamplesResult } from '../../src/shared/ipc';

// Install-examples VIEW organism (§18.1/§23.4 / UI-STANDARDS): preview → conditional overwrite prompt →
// apply → result reporting. Tests assert the observable DOM + the injected contract, never internals.
describe('install examples view organism (§18.1/§23.4)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  const okResult = (over: Partial<Extract<InstallExamplesResult, { ok: true }>> = {}): InstallExamplesResult => ({
    ok: true,
    created: ['flow.yaml'],
    overwritten: [],
    skipped: [],
    ...over,
  });
  const deps = (over: Partial<InstallExamplesDeps> = {}): InstallExamplesDeps => ({
    preview: vi.fn(async (): Promise<InstallExamplesPreview> => ({ conflicts: [] })),
    apply: vi.fn(async (): Promise<InstallExamplesResult> => okResult()),
    ...over,
  });
  const button = (): HTMLButtonElement => host.querySelector('button') as HTMLButtonElement;
  const status = (): HTMLElement => host.querySelector('[role="status"]') as HTMLElement;
  const alert = (): HTMLElement | null => host.querySelector('[role="alert"]');
  const prompt = (): HTMLElement | null => host.querySelector('.flow-modal');
  const overwriteBtn = (): HTMLButtonElement => host.querySelector('.flow-modal button.overwrite') as HTMLButtonElement;
  const keepBtn = (): HTMLButtonElement => host.querySelector('.flow-modal button.keep') as HTMLButtonElement;

  it('renders an install button, a status live region, and an assertive alert region', () => {
    createInstallExamples(host, deps());
    expect(button()).toBeTruthy();
    expect(status()).toBeTruthy();
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(alert()).toBeTruthy();
  });

  it('titles its section with a top-level heading to match its peer settings panels (WCAG 1.3.1)', () => {
    createInstallExamples(host, deps());
    expect(host.querySelector('h2')).toBeNull();
    expect(host.querySelector('h1')).toBeTruthy();
  });

  it('installs without a prompt when preview reports no conflict, calling apply with no overwrite', async () => {
    const apply = vi.fn(async () => okResult({ created: ['flow.yaml', 'todo-templates/a.md'] }));
    createInstallExamples(host, deps({ preview: vi.fn(async () => ({ conflicts: [] })), apply }));
    button().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(false);
    expect(prompt()).toBeNull(); // no overwrite prompt when nothing conflicts
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
  });

  it('shows the up-front overwrite prompt when preview reports a conflict, before any apply', async () => {
    const apply = vi.fn(async () => okResult());
    createInstallExamples(host, deps({ preview: vi.fn(async () => ({ conflicts: ['flow.yaml'] })), apply }));
    button().click();
    await vi.waitFor(() => expect(prompt()).not.toBeNull());
    expect(apply).not.toHaveBeenCalled(); // the prompt precedes the write
  });

  it('opting into the prompt applies with overwrite=true and reports the overwritten files', async () => {
    const apply = vi.fn(async () => okResult({ created: [], overwritten: ['flow.yaml'] }));
    createInstallExamples(host, deps({ preview: vi.fn(async () => ({ conflicts: ['flow.yaml'] })), apply }));
    button().click();
    await vi.waitFor(() => expect(overwriteBtn()).toBeTruthy());
    overwriteBtn().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('overwrote'));
    expect(prompt()).toBeNull(); // prompt closes after the choice
  });

  it('declining the prompt applies with overwrite=false so absent files still install', async () => {
    const apply = vi.fn(async () => okResult({ created: ['todo-templates/a.md'], skipped: ['flow.yaml'] }));
    createInstallExamples(host, deps({ preview: vi.fn(async () => ({ conflicts: ['flow.yaml'] })), apply }));
    button().click();
    await vi.waitFor(() => expect(keepBtn()).toBeTruthy());
    keepBtn().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(false));
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('skipped'));
  });

  it('announces an install error through the assertive alert region (WCAG 4.1.3)', async () => {
    const apply = vi.fn(async (): Promise<InstallExamplesResult> => ({ ok: false, error: 'refused: symlinked home' }));
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('refused: symlinked home'));
    expect(status().className).not.toMatch(/\bok\b/);
  });

  it('routes a thrown preview error through the assertive alert region', async () => {
    const preview = vi.fn(async (): Promise<InstallExamplesPreview> => { throw new Error('ipc down'); });
    createInstallExamples(host, deps({ preview }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('ipc down'));
  });

  it('does not start a second run while one is already in flight', async () => {
    let resolvePreview: (p: InstallExamplesPreview) => void = () => {};
    const preview = vi.fn(() => new Promise<InstallExamplesPreview>((r) => { resolvePreview = r; }));
    createInstallExamples(host, deps({ preview }));
    button().click();
    await vi.waitFor(() => expect(button().disabled).toBe(true));
    button().click();
    expect(preview).toHaveBeenCalledTimes(1);
    resolvePreview({ conflicts: [] });
  });

  it('re-enables the install button after a run completes so a retry is possible', async () => {
    createInstallExamples(host, deps());
    button().click();
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
    expect(button().disabled).toBe(false);
  });

  it('dispose() clears the view from its host', () => {
    const view = createInstallExamples(host, deps());
    expect(host.childElementCount).toBeGreaterThan(0);
    view.dispose();
    expect(host.childElementCount).toBe(0);
  });

  it('builds its DOM from the host document, not the ambient global (relocatable, §3.3)', async () => {
    await assertRendersFromHostDocument((h) => { createInstallExamples(h, deps()); });
  });
});
