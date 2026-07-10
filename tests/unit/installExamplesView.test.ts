// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInstallExamples, type InstallExamplesDeps } from '../../src/renderer/src/installExamples';
import { assertRendersFromHostDocument } from './relocatable';
import type {
  InstallDestinationId,
  InstallDestinationPreview,
  InstallExamplesPreview,
  InstallExamplesResult,
} from '../../src/shared/ipc';

// Install-examples VIEW organism (§18.1/§23.4 / UI-STANDARDS): preview → conditional per-destination
// consent step → apply → destination-grouped result reporting. Tests assert the observable DOM + the
// injected contract, never internals.
describe('install examples view organism (§18.1/§23.4)', () => {
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  const cleanDestinations: InstallDestinationPreview[] = [
    { destination: 'flow', conflict: false },
    { destination: 'loops', conflict: false },
    { destination: 'skills', conflict: false },
    { destination: 'commands', conflict: false },
  ];
  const clean: InstallExamplesPreview = { ok: true, destinations: cleanDestinations };
  const conflicting = (...ids: InstallDestinationId[]): InstallExamplesPreview => ({
    ok: true,
    destinations: cleanDestinations.map((d) =>
      ids.includes(d.destination) ? { destination: d.destination, conflict: true, files: [`${d.destination}-file.md`] } : d,
    ),
  });

  const okResult = (over: Partial<Extract<InstallExamplesResult, { ok: true }>> = {}): InstallExamplesResult => ({
    ok: true,
    created: [{ destination: 'flow', files: ['flow.yaml'] }],
    overwritten: [],
    skipped: [],
    ...over,
  });
  const deps = (over: Partial<InstallExamplesDeps> = {}): InstallExamplesDeps => ({
    preview: vi.fn(async (): Promise<InstallExamplesPreview> => clean),
    apply: vi.fn(async (): Promise<InstallExamplesResult> => okResult()),
    ...over,
  });

  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const button = (): HTMLButtonElement => host.querySelector('.kprofile button') as HTMLButtonElement;
  const status = (): HTMLElement => host.querySelector('[role="status"]') as HTMLElement;
  const alert = (): HTMLElement | null => host.querySelector('[role="alert"]');
  const prompt = (): HTMLElement | null => host.querySelector('.flow-modal');
  const confirmBtn = (): HTMLButtonElement => host.querySelector('.flow-modal button.confirm') as HTMLButtonElement;
  const cancelBtn = (): HTMLButtonElement => host.querySelector('.flow-modal button.cancel') as HTMLButtonElement;
  const consentBox = (id: InstallDestinationId): HTMLInputElement =>
    host.querySelector(`.flow-modal input[type="checkbox"][data-destination="${id}"]`) as HTMLInputElement;
  const scrim = (): HTMLElement => host.querySelector('.flow-scrim') as HTMLElement;
  const reportGroup = (id: InstallDestinationId): HTMLElement | null =>
    host.querySelector(`.install-report [data-destination="${id}"]`);
  const reportList = (): HTMLElement => host.querySelector('.install-report') as HTMLElement;
  const busy = (): string | null => button().getAttribute('aria-disabled');

  async function openConsent(
    conflicts: InstallDestinationId[],
    over: Partial<InstallExamplesDeps> = {},
  ): Promise<void> {
    createInstallExamples(host, deps({ preview: vi.fn(async () => conflicting(...conflicts)), ...over }));
    button().focus();
    button().click();
    await vi.waitFor(() => expect(prompt()).not.toBeNull());
  }

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

  it('gives the install button an accessible name that contains its visible label (WCAG 2.5.3)', () => {
    createInstallExamples(host, deps());
    const b = button();
    const visible = b.textContent?.trim() ?? '';
    expect(visible).toBe('Install examples');
    const accessibleName = b.getAttribute('aria-label') ?? b.textContent ?? '';
    expect(accessibleName).toContain(visible);
  });

  it('installs without a consent step when no destination conflicts, replacing nothing', async () => {
    const apply = vi.fn(async () => okResult());
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith([]);
    expect(prompt()).toBeNull();
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
  });

  it('shows the consent step before any apply when a destination conflicts', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['skills'], { apply });
    expect(apply).not.toHaveBeenCalled();
  });

  it('offers one decision per CONFLICTING destination and none for the clean ones', async () => {
    await openConsent(['skills', 'commands']);
    expect(consentBox('skills')).toBeTruthy();
    expect(consentBox('commands')).toBeTruthy();
    expect(consentBox('flow')).toBeNull();
    expect(consentBox('loops')).toBeNull();
  });

  it('names the conflicting files under each destination so the user knows what is at stake', async () => {
    await openConsent(['skills']);
    expect(prompt()?.textContent).toContain('skills-file.md');
  });

  it('forwards only the consented destinations — one decision never covers two', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['skills', 'commands'], { apply });
    consentBox('commands').click();
    confirmBtn().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(['commands']));
  });

  it('forwards an empty list when the user confirms with nothing checked, so absent files still install', async () => {
    const apply = vi.fn(async () => okResult({ created: [{ destination: 'loops', files: ['plan-loop/plan-loop.yaml'] }], skipped: [{ destination: 'skills', files: ['a/SKILL.md'] }] }));
    await openConsent(['skills'], { apply });
    confirmBtn().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledWith([]));
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('skipped'));
    expect(prompt()).toBeNull();
  });

  it('gives the report list an accessible name so its purpose is announced (WCAG 1.3.1)', () => {
    createInstallExamples(host, deps());
    expect(reportList().getAttribute('aria-label')?.trim()).toBeTruthy();
  });

  it('keeps the empty report list out of the accessibility tree until it has something to report (WCAG 4.1.2)', async () => {
    createInstallExamples(host, deps());
    expect(reportList().hidden).toBe(true);
    button().click();
    await vi.waitFor(() => expect(reportGroup('flow')).not.toBeNull());
    expect(reportList().hidden).toBe(false);
  });

  it('re-hides the report list when a run produces nothing to report', async () => {
    const apply = vi.fn(async () => okResult({ created: [], overwritten: [], skipped: [] }));
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(status().className).toMatch(/\bok\b/));
    expect(reportList().hidden).toBe(true);
  });

  it.each([
    ['the cancel button', () => cancelBtn().click()],
    ['Escape', () => prompt()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['the scrim', () => scrim().click()],
  ])('announces the cancellation rather than silently emptying the live region when dismissed with %s (WCAG 4.1.3)', async (_label, dismiss) => {
    await openConsent(['flow']);
    expect(status().textContent).toBe('Checking…');
    dismiss();
    expect(status().textContent).toBe('Install cancelled.');
  });

  it.each([
    ['the cancel button', () => cancelBtn().click()],
    ['Escape', () => prompt()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))],
    ['the scrim', () => scrim().click()],
  ])('returns focus to the install button when the consent step is dismissed with %s (WCAG 2.4.3)', async (_label, dismiss) => {
    await openConsent(['flow']);
    dismiss();
    expect(host.ownerDocument.activeElement).toBe(button());
  });

  it('still announces progress when the consent step is confirmed rather than dismissed', async () => {
    const applied = deferred<InstallExamplesResult>();
    const apply = vi.fn(() => applied.promise);
    await openConsent(['flow'], { apply });
    confirmBtn().click();
    expect(status().textContent).toBe('Installing…');
    applied.resolve(okResult());
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
  });

  it('cancelling the consent step writes nothing at all', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['flow'], { apply });
    cancelBtn().click();
    expect(prompt()).toBeNull();
    expect(apply).not.toHaveBeenCalled();
    expect(busy()).toBe('false');
  });

  it('groups the reported files under the destination each was written to', async () => {
    const apply = vi.fn(async () =>
      okResult({
        created: [{ destination: 'commands', files: ['groom-ticket.md'] }],
        overwritten: [{ destination: 'skills', files: ['review-intent/SKILL.md'] }],
        skipped: [{ destination: 'flow', files: ['flow.yaml'] }],
      }),
    );
    await openConsent(['skills'], { apply });
    consentBox('skills').click();
    confirmBtn().click();
    await vi.waitFor(() => expect(reportGroup('commands')).not.toBeNull());

    expect(reportGroup('commands')?.textContent).toContain('groom-ticket.md');
    expect(reportGroup('skills')?.textContent).toContain('review-intent/SKILL.md');
    expect(reportGroup('flow')?.textContent).toContain('flow.yaml');
    expect(reportGroup('loops')).toBeNull(); // a destination with nothing to report gets no group
    // A file name shared across destinations stays attributable to the group it is listed under.
    expect(reportGroup('commands')?.textContent).not.toContain('flow.yaml');
  });

  it('summarizes the outcome in the live region rather than reading out every file name (WCAG 4.1.3)', async () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.md`);
    const apply = vi.fn(async () => okResult({ created: [{ destination: 'loops', files: many }] }));
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(status().className).toMatch(/\bok\b/));
    expect(status().textContent).toContain('created 20');
    expect(status().textContent).not.toContain('f19.md');
    expect(reportGroup('loops')?.textContent).toContain('f19.md');
  });

  it('reports what it wrote AND what it left alone before failing, alongside the error (mid-write failure)', async () => {
    const apply = vi.fn(
      async (): Promise<InstallExamplesResult> => ({
        ok: false,
        error: 'Could not install groom-ticket.md',
        created: [{ destination: 'loops', files: ['plan-loop/plan-loop.yaml'] }],
        overwritten: [],
        skipped: [{ destination: 'skills', files: ['review-intent/SKILL.md'] }],
      }),
    );
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('Could not install groom-ticket.md'));
    expect(reportGroup('loops')?.textContent).toContain('plan-loop/plan-loop.yaml');
    // The failure arm carries skipped too, so the report shows what was preserved, not just what landed.
    expect(reportGroup('skills')?.textContent).toContain('review-intent/SKILL.md');
  });

  it('clears a previous report when a new run starts', async () => {
    const preview = vi.fn(async () => clean);
    createInstallExamples(host, deps({ preview }));
    button().click();
    await vi.waitFor(() => expect(reportGroup('flow')).not.toBeNull());
    button().click();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
  });

  it('returns focus to the install button after confirming the consent step (WCAG 2.4.3)', async () => {
    const apply = vi.fn(async () => okResult({ created: [], overwritten: [{ destination: 'flow', files: ['flow.yaml'] }] }));
    await openConsent(['flow'], { apply });
    confirmBtn().click();
    await vi.waitFor(() => expect(status().className).toMatch(/\bok\b/));
    expect(host.ownerDocument.activeElement).toBe(button());
  });

  it('keeps focus on the install button while the install is in flight (WCAG 2.4.3)', async () => {
    const applied = deferred<InstallExamplesResult>();
    const apply = vi.fn(() => applied.promise);
    createInstallExamples(host, deps({ apply }));
    button().focus();
    button().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(status().textContent).toBe('Installing…');
    expect(host.ownerDocument.activeElement).toBe(button());
    expect(button().getAttribute('aria-busy')).toBe('true');
    applied.resolve(okResult());
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
    expect(button().getAttribute('aria-busy')).toBe('false');
  });

  it('does not yank focus back to the button if the user moved focus away during install (WCAG 2.4.3)', async () => {
    const applied = deferred<InstallExamplesResult>();
    const apply = vi.fn(() => applied.promise);
    createInstallExamples(host, deps({ apply }));
    const other = document.createElement('input');
    document.body.appendChild(other);
    button().focus();
    button().click();
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    other.focus();
    applied.resolve(okResult());
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
    expect(host.ownerDocument.activeElement).toBe(other);
  });

  it('announces an install error through the assertive alert region (WCAG 4.1.3)', async () => {
    const apply = vi.fn(
      async (): Promise<InstallExamplesResult> => ({ ok: false, error: 'refused: symlinked home', created: [], overwritten: [], skipped: [] }),
    );
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

  it('routes a refused preview (ok:false) to the alert region and applies nothing', async () => {
    const apply = vi.fn(async () => okResult());
    const preview = vi.fn(async (): Promise<InstallExamplesPreview> => ({ ok: false, error: 'refused: wrong session' }));
    createInstallExamples(host, deps({ preview, apply }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('refused: wrong session'));
    expect(apply).not.toHaveBeenCalled();
    expect(busy()).toBe('false');
  });

  it('does not start a second run while one is already in flight', async () => {
    const previewed = deferred<InstallExamplesPreview>();
    const preview = vi.fn(() => previewed.promise);
    createInstallExamples(host, deps({ preview }));
    button().click();
    await vi.waitFor(() => expect(busy()).toBe('true'));
    button().click();
    expect(preview).toHaveBeenCalledTimes(1);
    previewed.resolve(clean);
  });

  it('keeps the install button operable while the consent step is open so a scrim dismissal cannot strand it', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['flow'], { apply });
    expect(busy()).toBe('false');
    scrim().click();
    expect(prompt()).toBeNull();
    expect(busy()).toBe('false');
    expect(apply).not.toHaveBeenCalled();
  });

  it('keeps the install button operable when the consent step is dismissed with Escape without a choice', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['flow'], { apply });
    prompt()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(prompt()).toBeNull();
    expect(busy()).toBe('false');
    expect(apply).not.toHaveBeenCalled();
  });

  it('re-enables the install button after a run completes so a retry is possible', async () => {
    createInstallExamples(host, deps());
    button().click();
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
    expect(busy()).toBe('false');
  });

  it('marks the install button aria-disabled while a run is in flight rather than removing it from the tab order (WCAG 2.4.3)', async () => {
    const previewed = deferred<InstallExamplesPreview>();
    createInstallExamples(host, deps({ preview: vi.fn(() => previewed.promise) }));
    button().focus();
    button().click();
    await vi.waitFor(() => expect(busy()).toBe('true'));
    expect(button().disabled).toBe(false);
    expect(host.ownerDocument.activeElement).toBe(button());
    previewed.resolve(clean);
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

  it('renders identically across two host placements (relocation, §3.3)', () => {
    const a = document.createElement('section');
    const b = document.createElement('aside');
    document.body.append(a, b);
    createInstallExamples(a, deps());
    createInstallExamples(b, deps());
    const shape = (h: HTMLElement) => ({
      buttons: h.querySelectorAll('button').length,
      status: h.querySelectorAll('[role="status"]').length,
      alert: h.querySelectorAll('[role="alert"]').length,
      report: h.querySelectorAll('.install-report').length,
    });
    expect(shape(a)).toEqual(shape(b));
    expect(shape(a).buttons).toBe(1);
    expect(shape(a).status).toBe(1);
    expect(shape(a).alert).toBe(1);
    expect(shape(a).report).toBe(1);
  });
});
