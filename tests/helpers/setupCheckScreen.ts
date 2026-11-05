import { expect } from 'vitest';
import { accessibleName, everyByRole } from './byRole';

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

type ScreenRole = Parameters<typeof everyByRole>[1];

/** Only what assistive technology is shown: an element under a `hidden` or `aria-hidden="true"` ancestor (itself
 *  included) is not on screen, so a control the organism hid never reads as shown. */
const exposed = (host: ParentNode, role: ScreenRole): HTMLElement[] =>
  everyByRole(host, role).filter((el) => el.closest('[hidden], [aria-hidden="true"]') === null);

/** The setup-check popup inside `host`, read by role and accessible name through `byRole.ts`'s one matcher
 *  (UI-STANDARDS.md §3.4). A setup-dialog test reads the screen only through this helper, which lint enforces. */
export function setupCheckScreen(host: ParentNode) {
  const open = (): HTMLElement => {
    const dialogs = exposed(host, 'dialog');
    expect(dialogs, 'exactly one setup dialog open').toHaveLength(1);
    return dialogs[0];
  };
  return {
    /** Whether a dialog is open in the host; fails when more than one is. */
    isOpen(): boolean {
      const dialogs = exposed(host, 'dialog');
      expect(dialogs.length, 'at most one setup dialog open').toBeLessThanOrEqual(1);
      return dialogs.length === 1;
    },
    dialog: open,
    /** The dialog's accessible name. */
    title: (): string => accessibleName(open()),
    /** The dialog's accessible description, from the elements its `aria-describedby` names. */
    description(): string {
      const dialog = open();
      const ids = (dialog.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
      return ids.map((id) => dialog.ownerDocument.getElementById(id)).map((el) => (el ? text(el) : '')).join(' ').trim();
    },
    /** One string per listed condition, in order. */
    entries: (): string[] => exposed(open(), 'listitem').map(text),
    /** The accessible names of every button in the dialog, in order. */
    controls: (): string[] => exposed(open(), 'button').map(accessibleName),
    /** The one button named `name`; fails when there is not exactly one. */
    control(name: string): HTMLElement {
      const found = exposed(open(), 'button').filter((el) => accessibleName(el) === name);
      expect(found, `exactly one shown button named "${name}"`).toHaveLength(1);
      return found[0];
    },
    hasControl: (name: string): boolean => exposed(open(), 'button').some((el) => accessibleName(el) === name),
    /** The text of the dialog's alert region, or null when it shows none. */
    alert(): string | null {
      const alerts = exposed(open(), 'alert').map(text).filter(Boolean);
      expect(alerts.length, 'at most one alert in the setup dialog').toBeLessThanOrEqual(1);
      return alerts[0] ?? null;
    },
    pressEscape(): void {
      const dialog = open();
      const target = dialog.contains(dialog.ownerDocument.activeElement) ? dialog.ownerDocument.activeElement! : dialog;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    },
    /** Clicks the scrim, the modal shell's backdrop, which has no role: it is the dialog's preceding sibling. */
    pressScrim(): void {
      const scrim = open().previousElementSibling;
      expect(scrim, 'the setup dialog has a scrim').toBeInstanceOf(HTMLElement);
      (scrim as HTMLElement).click();
    },
  };
}

export type SetupCheckScreen = ReturnType<typeof setupCheckScreen>;

/** Records the text of each setup dialog added to `host`, in the order they were added, read from the mutation
 *  records themselves so a dialog replaced before anyone looked is still on the record. Call the returned
 *  function to read it. */
export function recordSetupDialogs(host: HTMLElement): () => string[] {
  const seen: string[] = [];
  const isDialog = (el: Element): boolean => el.getAttribute('role') === 'dialog';
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...everyByRole(node, 'dialog')]) if (isDialog(el)) seen.push(text(el));
      }
    }
  });
  observer.observe(host, { childList: true, subtree: true });
  return () => {
    for (const record of observer.takeRecords()) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        for (const el of [node, ...everyByRole(node, 'dialog')]) if (isDialog(el)) seen.push(text(el));
      }
    }
    return [...seen];
  };
}
