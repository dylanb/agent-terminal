// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createInstallExamples, type InstallExamplesDeps } from '../../src/renderer/src/installExamples';
import { assertRendersFromHostDocument } from './relocatable';
import type {
  DestRelativePath,
  InstallDestinationId,
  InstallDestinationPreview,
  InstallExamplesPreview,
  InstallExamplesResult,
  InstallPreviewId,
  RetiredExample,
} from '../../src/shared/ipc';
import { RETIRED_FLOW_IDS } from '../../src/shared/retiredFlows';

// Install-examples VIEW organism (§18.1/§23.4 / UI-STANDARDS): preview → conditional per-destination
// consent step → apply → destination-grouped result reporting. Tests assert the observable DOM + the
// injected contract, never internals.
describe('install examples view organism (§18.1/§23.4)', () => {
  const PREVIEW_ID = 'preview-1' as InstallPreviewId;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  // The contract types a destination-relative path (DestRelativePath), so a fixture says so once here
  // rather than casting at every literal.
  const rels = (...p: string[]): DestRelativePath[] => p as DestRelativePath[];

  const cleanDestinations: InstallDestinationPreview[] = [
    { destination: 'flow', conflict: false },
    { destination: 'appLoops', conflict: false },
    { destination: 'commands', conflict: false },
  ];
  const clean: InstallExamplesPreview = {
    ok: true,
    previewId: PREVIEW_ID,
    destinations: cleanDestinations,
    retired: [],
    retiredFallback: null,
  };
  const conflicting = (...ids: InstallDestinationId[]): InstallExamplesPreview => ({
    ok: true,
    previewId: PREVIEW_ID,
    destinations: cleanDestinations.map((d) =>
      ids.includes(d.destination) ? { destination: d.destination, conflict: true, files: rels(`${d.destination}-file.md`) } : d,
    ),
    retired: [],
    retiredFallback: null,
  });
  const RETIRED: RetiredExample[] = [
    { destination: 'flowCatalog', rel: 'feature-dev-v2' as DestRelativePath },
    { destination: 'agents', rel: 'plan-polish-loop--review-plan-intent.md' as DestRelativePath },
  ];
  const withRetired = (preview: InstallExamplesPreview): InstallExamplesPreview =>
    preview.ok ? { ...preview, retired: RETIRED } : preview;

  const okResult = (over: Partial<Extract<InstallExamplesResult, { ok: true }>> = {}): InstallExamplesResult => ({
    ok: true,
    created: [{ destination: 'flow', files: rels('flow.yaml') }],
    overwritten: [],
    skipped: [],
    notInstalled: [],
    removed: [],
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
    expect(apply).toHaveBeenCalledWith(PREVIEW_ID, [], false);
    expect(prompt()).toBeNull();
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('created'));
  });

  it('shows the consent step before any apply when a destination conflicts', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['appLoops'], { apply });
    expect(apply).not.toHaveBeenCalled();
  });

  it('offers one decision per CONFLICTING destination and none for the clean ones', async () => {
    await openConsent(['appLoops', 'commands']);
    expect(consentBox('appLoops')).toBeTruthy();
    expect(consentBox('commands')).toBeTruthy();
    expect(consentBox('flow')).toBeNull();
  });

  it('names the conflicting files under each destination so the user knows what is at stake', async () => {
    await openConsent(['appLoops']);
    expect(prompt()?.textContent).toContain('appLoops-file.md');
  });

  it('forwards only the consented destinations — one decision never covers two', async () => {
    const apply = vi.fn(async () => okResult());
    await openConsent(['appLoops', 'commands'], { apply });
    consentBox('commands').click();
    confirmBtn().click();
    await vi.waitFor(() =>
      expect(apply).toHaveBeenCalledWith(PREVIEW_ID, ['commands'], false),
    );
  });

  it('forwards an empty list when the user confirms with nothing checked, so absent files still install', async () => {
    const apply = vi.fn(async () => okResult({ created: [{ destination: 'appLoops', files: rels('plan-loop.yaml') }], skipped: [{ destination: 'commands', files: rels('groom-ticket.md') }] }));
    await openConsent(['appLoops'], { apply });
    confirmBtn().click();
    await vi.waitFor(() =>
      expect(apply).toHaveBeenCalledWith(PREVIEW_ID, [], false),
    );
    await vi.waitFor(() => expect(status().textContent?.toLowerCase()).toContain('skipped'));
    expect(prompt()).toBeNull();
  });

  describe('removing what the retired flows left behind (§18.1 v2.212)', () => {
    const retiredBox = (): HTMLInputElement | null => host.querySelector('.flow-modal input[type="checkbox"][data-retired]');

    async function openWithRetired(conflicts: InstallDestinationId[], apply: InstallExamplesDeps['apply']): Promise<void> {
      createInstallExamples(host, deps({ preview: vi.fn(async () => withRetired(conflicting(...conflicts))), apply }));
      button().click();
      await vi.waitFor(() => expect(prompt()).not.toBeNull());
    }

    it('asks before installing when only retired leftovers are found, offering their removal unchecked', async () => {
      const apply = vi.fn(async () => okResult());
      await openWithRetired([], apply);
      expect(apply).not.toHaveBeenCalled();
      expect(retiredBox()).not.toBeNull();
      expect(retiredBox()?.checked).toBe(false);
    });

    it('names every leftover it would remove, outside the checkbox name (accname 1.2, WCAG 4.1.2)', async () => {
      await openWithRetired([], vi.fn(async () => okResult()));
      expect(prompt()?.textContent).toContain('feature-dev-v2');
      expect(prompt()?.textContent).toContain('plan-polish-loop--review-plan-intent.md');
      const box = retiredBox() as HTMLInputElement;
      expect(box.closest('label')?.textContent).not.toContain('plan-polish-loop--review-plan-intent.md');
      const described = host.querySelector(`#${box.getAttribute('aria-describedby')}`);
      expect(described?.textContent).toContain('plan-polish-loop--review-plan-intent.md');
    });

    it('keeps the leftovers when the user installs without ticking the removal', async () => {
      const apply = vi.fn(async () => okResult());
      await openWithRetired([], apply);
      confirmBtn().click();
      await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(PREVIEW_ID, [], false));
    });

    it('asks for the removal when the user ticks it, independently of any replacement', async () => {
      const apply = vi.fn(async () => okResult());
      await openWithRetired(['appLoops'], apply);
      expect(consentBox('appLoops').checked).toBe(false);
      (retiredBox() as HTMLInputElement).click();
      confirmBtn().click();
      await vi.waitFor(() => expect(apply).toHaveBeenCalledWith(PREVIEW_ID, [], true));
    });

    it('names each retired flow as what left the files behind', async () => {
      await openWithRetired([], vi.fn(async () => okResult()));
      for (const id of RETIRED_FLOW_IDS) expect(prompt()?.textContent).toContain(id);
    });

    it('warns, beside the removal, that a fallback flow still on a retired flow may use what it removes, and to replace the flow home', async () => {
      createInstallExamples(host, deps({ preview: vi.fn(async () => ({ ...withRetired(conflicting('flow')), retiredFallback: 'feature-dev-v2' }) as InstallExamplesPreview) }));
      button().click();
      await vi.waitFor(() => expect(prompt()).not.toBeNull());
      const described = host.querySelector(`#${(retiredBox() as HTMLInputElement).getAttribute('aria-describedby')}`);
      expect(described?.textContent).toContain('Your fallback flow is still the retired feature-dev-v2, which may use what these remove');
      expect(described?.textContent).toContain('Flow home');
    });

    it('gives no fallback warning when the fallback flow is not a retired one', async () => {
      await openWithRetired(['flow'], vi.fn(async () => okResult()));
      expect(prompt()?.textContent).not.toContain('fallback flow');
    });

    it('offers no removal when nothing retired was found', async () => {
      await openConsent(['appLoops']);
      expect(retiredBox()).toBeNull();
    });

    it('reports what it removed under the destination it was removed from', async () => {
      const apply = vi.fn(async () => okResult({ removed: RETIRED }));
      await openWithRetired([], apply);
      (retiredBox() as HTMLInputElement).click();
      confirmBtn().click();
      await vi.waitFor(() => expect(reportGroup('agents')).not.toBeNull());
      expect(reportGroup('agents')?.textContent).toContain('removed 1: plan-polish-loop--review-plan-intent.md');
      expect(reportGroup('flowCatalog')?.textContent).toContain('removed 1: feature-dev-v2');
      await vi.waitFor(() => expect(status().textContent).toContain('removed 2'));
    });
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
        created: [{ destination: 'commands', files: rels('groom-ticket.md') }],
        overwritten: [{ destination: 'appLoops', files: rels('plan-loop.yaml') }],
        skipped: [],
      }),
    );
    await openConsent(['appLoops'], { apply });
    consentBox('appLoops').click();
    confirmBtn().click();
    await vi.waitFor(() => expect(reportGroup('commands')).not.toBeNull());

    expect(reportGroup('commands')?.textContent).toContain('groom-ticket.md');
    expect(reportGroup('appLoops')?.textContent).toContain('plan-loop.yaml');
    expect(reportGroup('flow')).toBeNull(); // a destination with nothing to report gets no group
    // A file name shared across destinations stays attributable to the group it is listed under.
    expect(reportGroup('commands')?.textContent).not.toContain('plan-loop.yaml');
  });

  it('reports a destination skipped because its tool is not installed, naming the missing directory (§18.1 v2.199)', async () => {
    const apply = vi.fn(async () => okResult({ notInstalled: [{ destination: 'codexLoops', root: '/home/u/.codex' }] }));
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(reportGroup('codexLoops')).not.toBeNull());
    expect(reportGroup('codexLoops')?.textContent).toContain('Codex loop definitions');
    expect(reportGroup('codexLoops')?.textContent).toContain('not installed: /home/u/.codex does not exist');
  });

  it('summarizes the outcome in the live region rather than reading out every file name (WCAG 4.1.3)', async () => {
    const many = rels(...Array.from({ length: 20 }, (_, i) => `f${i}.md`));
    const apply = vi.fn(async () => okResult({ created: [{ destination: 'appLoops', files: many }] }));
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(status().className).toMatch(/\bok\b/));
    expect(status().textContent).toContain('created 20');
    expect(status().textContent).not.toContain('f19.md');
    expect(reportGroup('appLoops')?.textContent).toContain('f19.md');
  });

  it('reports what it wrote AND what it left alone before failing, alongside the error (mid-write failure)', async () => {
    const apply = vi.fn(
      async (): Promise<InstallExamplesResult> => ({
        ok: false,
        error: 'Could not install groom-ticket.md',
        created: [{ destination: 'appLoops', files: rels('plan-loop.yaml') }],
        overwritten: [],
        skipped: [{ destination: 'commands', files: rels('other-cmd.md') }],
        notInstalled: [],
        removed: [],
      }),
    );
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('Could not install groom-ticket.md'));
    expect(reportGroup('appLoops')?.textContent).toContain('plan-loop.yaml');
    // The failure arm carries skipped too, so the report shows what was preserved, not just what landed.
    expect(reportGroup('commands')?.textContent).toContain('other-cmd.md');
  });

  it('clears a previous report when a new run starts', async () => {
    // Hold the second preview pending and assert the report is GONE while it runs — the previous
    // assertion (preview called twice) passed with the clearing deleted, because renderReport replaces
    // the list's children on the way back in either way.
    const gate = deferred<InstallExamplesPreview>();
    let call = 0;
    const preview = vi.fn(async (): Promise<InstallExamplesPreview> => {
      call += 1;
      return call === 1 ? clean : gate.promise;
    });
    createInstallExamples(host, deps({ preview }));
    button().click();
    await vi.waitFor(() => expect(reportGroup('flow')).not.toBeNull());
    expect(reportList().hidden).toBe(false);

    button().click();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(reportGroup('flow')).toBeNull();
    expect(reportList().hidden).toBe(true);
    gate.resolve(clean);
  });

  it('renders the report groups in the contract order, whatever order the result arrives in', async () => {
    // renderReport iterates INSTALL_DESTINATION_IDS so the display order is single-sourced from the
    // contract. Hand it the groups reversed; the DOM must still come back in contract order.
    const apply = vi.fn(
      async (): Promise<InstallExamplesResult> => ({
        ok: true,
        created: [
          { destination: 'commands', files: rels('groom-ticket.md') },
          { destination: 'flow', files: rels('flow.yaml') },
        ],
        overwritten: [{ destination: 'appLoops', files: rels('plan-loop.yaml') }],
        skipped: [],
        notInstalled: [],
        removed: [],
      }),
    );
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(reportGroup('flow')).not.toBeNull());
    const order = [...reportList().children].map((li) => li.getAttribute('data-destination'));
    expect(order).toEqual(['flow', 'appLoops', 'commands']);
  });

  it('exposes the consent options as a NAMED group (WAI-ARIA group; WCAG 1.3.1)', async () => {
    // A <fieldset>/<legend> gave this by construction. A div carrying role="group" + aria-labelledby buys
    // the layout the dialog needs, but pays for it with three strings that must agree — so they are pinned.
    await openConsent(['appLoops', 'commands']);
    const group = host.querySelector('.flow-modal .install-consent') as HTMLElement;
    expect(group.getAttribute('role')).toBe('group');

    const labelledBy = group.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const label = host.ownerDocument.getElementById(labelledBy as string);
    expect(label?.textContent?.trim()).toBe('Replace files in');

    // Every decision control lives inside the group it names.
    for (const id of ['appLoops', 'commands'] as InstallDestinationId[]) {
      expect(group.contains(consentBox(id))).toBe(true);
    }
  });

  it('keeps the conflicting file list out of a consent checkbox’s accessible name (accname 1.2, WCAG 4.1.2)', async () => {
    // The files sit inside the implicit <label>, so accname folds every path into the control's NAME:
    // a screen reader announces dozens of paths before the user learns which destination this is. The
    // manifest is a DESCRIPTION, not a name.
    await openConsent(['appLoops']);
    const box = consentBox('appLoops');
    const label = box.closest('label') as HTMLElement;
    expect(label.textContent).toContain('App loop definitions');
    expect(label.textContent).not.toContain('appLoops-file.md');

    const describedBy = box.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const desc = host.ownerDocument.getElementById(describedBy as string);
    expect(desc?.textContent).toContain('appLoops-file.md');
  });

  it('announces what was written even when the install fails partway (WCAG 4.1.3)', async () => {
    // The failure arm carries created/overwritten/skipped exactly as the success arm does, and this is
    // the branch where the user most needs them: the alert region must not drop to the bare error.
    const apply = vi.fn(
      async (): Promise<InstallExamplesResult> => ({
        ok: false,
        error: 'Could not install groom-ticket.md',
        created: [{ destination: 'appLoops', files: rels('plan-loop.yaml') }],
        overwritten: [],
        skipped: [{ destination: 'commands', files: rels('other-cmd.md') }],
        notInstalled: [],
        removed: [],
      }),
    );
    createInstallExamples(host, deps({ apply }));
    button().click();
    await vi.waitFor(() => expect(alert()?.textContent).toContain('Could not install groom-ticket.md'));
    const announced = alert()?.textContent ?? '';
    expect(announced).toMatch(/created 1/i);
    expect(announced).toMatch(/skipped 1/i);
  });

  it('returns focus to the install button after confirming the consent step (WCAG 2.4.3)', async () => {
    const apply = vi.fn(async () => okResult({ created: [], overwritten: [{ destination: 'flow', files: rels('flow.yaml') }] }));
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
      async (): Promise<InstallExamplesResult> => ({ ok: false, error: 'refused: symlinked home', created: [], overwritten: [], skipped: [], notInstalled: [], removed: [] }),
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

  // The live region's SEQUENCE of values is what an AT reads out — not just its final text. Confirming the
  // consent step is the user's affirmative answer, so it must not travel the shell's user-dismiss path: that
  // fires the organism's retraction and announces "Install cancelled." over an install that is in fact
  // running (WCAG 4.1.3). Reading only the settled DOM cannot see it; a MutationObserver sees what the AT does.
  describe('the consent step announces an accept as an accept, never as a cancellation', () => {
    const announced = (obs: MutationObserver): string[] =>
      obs.takeRecords().flatMap((r) => [...r.addedNodes]).map((n) => n.textContent ?? '');

    it('never announces "Install cancelled." on the Install path', async () => {
      await openConsent(['appLoops']);
      const region = status();
      const obs = new MutationObserver(() => {});
      obs.observe(region, { childList: true, characterData: true, subtree: true });

      confirmBtn().click();
      const said = announced(obs);
      obs.disconnect();

      expect(said).not.toContain('Install cancelled.');
      expect(said).toContain('Installing…');
    });

    it('still announces the retraction when the user DOES dismiss', async () => {
      await openConsent(['appLoops']);
      const region = status();
      const obs = new MutationObserver(() => {});
      obs.observe(region, { childList: true, characterData: true, subtree: true });

      cancelBtn().click();
      const said = announced(obs);
      obs.disconnect();

      expect(said).toContain('Install cancelled.');
    });
  });
});
