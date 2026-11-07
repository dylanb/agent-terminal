// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  asksBeforeInstall,
  createInstallConsent,
  DESTINATION_LABEL,
  type InstallConsent,
  type InstallPreview,
} from '../../src/renderer/src/installConsent';
import type { DestRelativePath, InstallDestinationId, RetiredExample } from '../../src/shared/ipc';

// Install-consent molecule (UI-STANDARDS §1.2/§3.1): the choice it yields matches what the operator ticked.
describe('install consent molecule', () => {
  const rels = (...p: string[]): DestRelativePath[] => p as DestRelativePath[];

  const preview = (conflictIds: InstallDestinationId[], retired: RetiredExample[] = []): InstallPreview => ({
    ok: true,
    previewId: 'preview-1' as InstallPreview['previewId'],
    destinations: [
      ...conflictIds.map((destination) => ({ destination, conflict: true as const, files: rels(`${destination}-file.md`) })),
      { destination: 'codexSkills' as const, conflict: false as const },
    ],
    retired,
    retiredFallback: null,
  });
  const RETIRED: RetiredExample[] = [{ destination: 'flowCatalog', rel: 'feature-dev-v2' as DestRelativePath }];

  const build = (p: InstallPreview): InstallConsent => {
    const consent = createInstallConsent(document, 'ic', p);
    document.body.replaceChildren(consent.explanation, consent.body);
    return consent;
  };

  const checkboxes = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const labelOf = (box: HTMLInputElement): string => box.labels?.[0]?.textContent ?? '';
  const tick = (box: HTMLInputElement): void => box.click();
  const destinationBox = (id: InstallDestinationId): HTMLInputElement => {
    const box = checkboxes().find((b) => labelOf(b).startsWith(DESTINATION_LABEL[id]));
    if (!box) throw new Error(`no checkbox for ${id}`);
    return box;
  };

  const DIFFERING: InstallDestinationId[] = ['agents', 'commands', 'appLoops'];

  describe('differing destinations', () => {
    it('yields exactly the ticked destinations and no retired removal', () => {
      const consent = build(preview(DIFFERING));
      tick(destinationBox('commands'));
      tick(destinationBox('appLoops'));
      expect(consent.choice().replace.slice().sort()).toEqual(['appLoops', 'commands']);
      expect(consent.choice().removeRetired).toBe(false);
    });

    it('yields nothing when nothing is ticked', () => {
      const consent = build(preview(DIFFERING));
      expect(consent.choice()).toEqual({ replace: [], removeRetired: false });
    });

    it('yields every destination when all are ticked', () => {
      const consent = build(preview(DIFFERING));
      for (const id of DIFFERING) tick(destinationBox(id));
      expect(consent.choice().replace.slice().sort()).toEqual([...DIFFERING].sort());
    });

    it('drops a destination that is ticked and then unticked', () => {
      const consent = build(preview(DIFFERING));
      tick(destinationBox('agents'));
      tick(destinationBox('commands'));
      tick(destinationBox('agents'));
      expect(consent.choice().replace).toEqual(['commands']);
    });
  });

  describe('retired examples', () => {
    it('removes retired examples only when the retired option is ticked, and replaces nothing', () => {
      const consent = build(preview([], RETIRED));
      const [retiredBox] = checkboxes();
      expect(checkboxes()).toHaveLength(1);
      expect(consent.choice()).toEqual({ replace: [], removeRetired: false });
      tick(retiredBox);
      expect(consent.choice()).toEqual({ replace: [], removeRetired: true });
      tick(retiredBox);
      expect(consent.choice()).toEqual({ replace: [], removeRetired: false });
    });

    it('keeps the destination choice and the retired choice independent', () => {
      const consent = build(preview(['agents', 'commands'], RETIRED));
      tick(destinationBox('agents'));
      expect(consent.choice()).toEqual({ replace: ['agents'], removeRetired: false });
      const retiredBox = checkboxes().find((b) => !labelOf(b).startsWith(DESTINATION_LABEL.agents) && !labelOf(b).startsWith(DESTINATION_LABEL.commands));
      if (!retiredBox) throw new Error('no retired checkbox');
      tick(retiredBox);
      expect(consent.choice()).toEqual({ replace: ['agents'], removeRetired: true });
    });
  });

  describe('asksBeforeInstall', () => {
    it('is true for a conflict', () => {
      expect(asksBeforeInstall(preview(['agents']))).toBe(true);
    });
    it('is true for retired examples alone', () => {
      expect(asksBeforeInstall(preview([], RETIRED))).toBe(true);
    });
    it('is false with neither', () => {
      expect(asksBeforeInstall(preview([]))).toBe(false);
    });
  });
});
