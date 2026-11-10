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

  const TITLE_ID = 'ic-title';
  const mount = (p: InstallPreview) => {
    const consent = createInstallConsent(document, TITLE_ID, p);
    const foot = document.createElement('div');
    const fallback = foot.appendChild(document.createElement('button'));
    const card = consent.card(foot, fallback);
    document.body.replaceChildren(card.card);
    return { consent, card, foot, fallback };
  };
  const build = (p: InstallPreview): InstallConsent => mount(p).consent;

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

  describe('the card it builds for a modal dialog', () => {
    it('is titled by the element the title id names, described by its explanation, and holds the caller footer', () => {
      const { card, foot } = mount(preview(DIFFERING));
      const title = document.getElementById(TITLE_ID);
      const description = card.describedById === undefined ? null : document.getElementById(card.describedById);
      expect.soft(title !== null && card.card.contains(title), 'the title is in the card').toBe(true);
      expect.soft(title?.textContent, 'the title').toBeTruthy();
      expect.soft(description !== null && card.card.contains(description), 'the description is in the card').toBe(true);
      expect.soft(description?.textContent, 'the description').toBeTruthy();
      expect.soft(card.card.contains(foot), 'the caller footer is in the card').toBe(true);
    });

    it('scrolls the choices, and its grow chain holds the scroll box', () => {
      const { card } = mount(preview(DIFFERING, RETIRED));
      expect.soft(card.scroll !== undefined && checkboxes().every((box) => card.scroll?.contains(box)), 'every choice is in the scroll box').toBe(true);
      expect.soft(card.scroll !== undefined && card.grow?.contains(card.scroll), 'the grow chain holds the scroll box').toBe(true);
    });

    it('focuses the first choice, the retired choice when it is the only one, and the fallback when there is none', () => {
      expect.soft(mount(preview(DIFFERING)).card.initialFocus, 'the first destination').toBe(checkboxes()[0]);
      expect.soft(mount(preview([], RETIRED)).card.initialFocus, 'the retired choice').toBe(checkboxes()[0]);
      const none = mount(preview([]));
      expect.soft(none.card.initialFocus, 'the fallback').toBe(none.fallback);
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
