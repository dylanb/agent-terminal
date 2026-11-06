// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetupCheckDialog, type SetupCheckDialog } from '../../src/renderer/src/setupCheckDialog';
import { APP_VERSION, ENTRY, REPO, fakeSetupDeps, plainStatus, repoStatus } from '../helpers/setupCheckFixtures';
import type { SetupConditionEntry, SetupDismissal } from '../../src/shared/setupCheck';
import { openModalDialogs, recordSetupDialogs, setupCheckScreen } from '../helpers/setupCheckScreen';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { createFlowInputModal } from '../../src/renderer/src/flowInputModal';
import type { FlowStateView } from '../../src/shared/ipc';

// The setup-check popup lists each condition the checked repository fails, in plain words, one message per
// failure kind.

const mounted: SetupCheckDialog[] = [];

function mountDialog(fake: ReturnType<typeof fakeSetupDeps>) {
  const host = document.body.appendChild(document.createElement('div'));
  const dialog = createSetupCheckDialog(host, fake.deps);
  mounted.push(dialog);
  return { host, dialog, screen: setupCheckScreen(host) };
}

/** Waits until the open dialog is the one raised for `repoKey`. */
const shownFor = (screen: ReturnType<typeof setupCheckScreen>, repoKey: string): Promise<void> =>
  vi.waitFor(() => {
    expect(screen.isOpen(), `a setup dialog is open for ${repoKey}`).toBe(true);
    expect(`${screen.title()} ${screen.description()}`).toContain(repoKey);
  });

beforeEach(() => document.body.replaceChildren());
afterEach(() => {
  for (const dialog of mounted.splice(0)) dialog.dispose();
});

describe('a check whose status lists conditions', () => {
  it('opens a dialog naming the repository with one entry per listed condition', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    expect(screen.entries()).toHaveLength(2);
  });

  it('gives each failure kind its own message (AC1, AC2, AC3, AC6, AC7)', async () => {
    const kinds = [
      ENTRY.absent,
      ENTRY.malformed,
      ENTRY.confinement,
      ENTRY.notIgnored,
      ENTRY.unchecked,
      ENTRY.examplesStale,
      ENTRY.examplesUnchecked,
    ];
    const messages: string[] = [];
    for (const entry of kinds) {
      const fake = fakeSetupDeps();
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [entry]));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.bravo);
      await shownFor(screen, REPO.bravo);
      messages.push(...screen.entries());
    }

    expect(
      { count: messages.length, distinct: new Set(messages.filter((m) => m.length > 0)).size },
      `messages: ${JSON.stringify(messages)}`,
    ).toEqual({ count: kinds.length, distinct: kinds.length });
  });
});

describe('a check whose status lists nothing', () => {
  it('opens no dialog: the next failing repository raises the first dialog shown', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, []));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = recordSetupDialogs(host);

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.charlie);
    await shownFor(screen, REPO.charlie);

    expect(seen()[0]).toContain(REPO.charlie);
  });
});

const KEYS = Object.values(REPO);

/** The repository the open dialog names, or null when none is open. */
function openFor(screen: ReturnType<typeof setupCheckScreen>): string | null {
  if (!screen.isOpen()) return null;
  const shown = `${screen.title()} ${screen.description()}`;
  return KEYS.find((key) => shown.includes(key)) ?? null;
}

/** The repository each recorded dialog named, in the order the dialogs appeared. */
const namedIn = (seen: () => string[]) => (): Array<string | null> =>
  seen().map((shown) => KEYS.find((key) => shown.includes(key)) ?? null);

/** Runs every microtask the fake status replies queue, which all settle before the next task. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A focusable control outside the dialog's host, focused, standing for where the operator was. */
function focusedOpener(): HTMLButtonElement {
  const opener = document.body.appendChild(document.createElement('button'));
  opener.textContent = 'opener';
  opener.focus();
  return opener;
}

const DOORS: Array<{ door: string; close: (screen: ReturnType<typeof setupCheckScreen>) => void }> = [
  { door: 'Close', close: (screen) => screen.control('Close').click() },
  { door: 'Escape', close: (screen) => screen.pressEscape() },
  { door: 'a scrim click', close: (screen) => screen.pressScrim() },
];

describe('the popup is a modal dialog (AC11)', () => {
  it('is announced as a modal dialog with its title and description, and takes focus on open', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);
    focusedOpener();

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    const shown = screen.dialog();
    expect({
      modal: shown.getAttribute('aria-modal'),
      named: screen.title().length > 0,
      described: screen.description().length > 0,
      focusInside: shown.contains(document.activeElement),
    }).toEqual({ modal: 'true', named: true, described: true, focusInside: true });
  });

  for (const { door, close } of DOORS) {
    it(`closes on ${door}, with focus back where the operator was`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      const { dialog, screen } = mountDialog(fake);
      const opener = focusedOpener();
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      close(screen);

      expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
        open: false,
        focusOnOpener: true,
      });
    });
  }

  it('lands focus through onFocusLost when the opener left the page while the dialog was open', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.malformed]));
    const { dialog, screen } = mountDialog(fake);
    const landing = document.body.appendChild(document.createElement('button'));
    landing.textContent = 'landing';
    fake.landFocusOn(landing);
    const opener = focusedOpener();
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);
    opener.remove();

    screen.pressEscape();

    expect(document.activeElement).toBe(landing);
  });

  it('dispose() removes the dialog without moving focus back to the opener', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);
    const opener = focusedOpener();
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    dialog.dispose();

    expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
      open: false,
      focusOnOpener: false,
    });
  });

  it('dispose() settles the check whose popup was open', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);
    let settled = false;
    void dialog.check(REPO.alpha).then(() => (settled = true));
    await shownFor(screen, REPO.alpha);

    dialog.dispose();
    await nextTask();

    expect(settled).toBe(true);
  });

  const PLACEMENTS: Array<{ placement: string; mount: () => HTMLElement }> = [
    { placement: 'a host directly under <body>', mount: () => document.body.appendChild(document.createElement('div')) },
    {
      placement: 'a host nested inside another region',
      mount: () => {
        const region = document.body.appendChild(document.createElement('section'));
        region.appendChild(document.createElement('p')).textContent = 'region content';
        return region.appendChild(document.createElement('div'));
      },
    },
  ];

  for (const { placement, mount } of PLACEMENTS) {
    it(`works the same in ${placement}, touching nothing outside its host (UI-STANDARDS.md §3.3)`, async () => {
      const outside = document.body.appendChild(document.createElement('aside'));
      outside.textContent = 'outside the host';
      const outsideBefore = outside.outerHTML;
      const host = mount();
      const fake = fakeSetupDeps();
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.unchecked]));
      const dialog = createSetupCheckDialog(host, fake.deps);
      mounted.push(dialog);
      const screen = setupCheckScreen(host);
      const opener = focusedOpener();

      void dialog.check(REPO.bravo);
      await shownFor(screen, REPO.bravo);
      const listed = screen.entries().length;
      screen.pressEscape();

      expect({
        listed,
        open: screen.isOpen(),
        focusOnOpener: document.activeElement === opener,
        outsideUnchanged: outside.outerHTML === outsideBefore,
      }).toEqual({ listed: 1, open: false, focusOnOpener: true, outsideUnchanged: true });
    });
  }
});

describe('another app dialog is open', () => {
  it('opens no setup dialog while it stays open, then opens once it closes', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    const { dialog, screen } = mountDialog(fake);
    fake.otherDialog.open();

    void dialog.check(REPO.alpha);
    await nextTask();
    const whileBlocked = screen.isOpen();
    fake.otherDialog.close();

    await vi.waitFor(() =>
      expect({ whileBlocked, afterItClosed: openFor(screen) }).toEqual({ whileBlocked: false, afterItClosed: REPO.alpha }),
    );
  });
  it('opens no setup dialog when the other one opened while the status request was still pending', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);
    const release = fake.hold(REPO.alpha);
    void dialog.check(REPO.alpha);
    await nextTask();

    fake.otherDialog.open();
    release();
    await nextTask();
    const whileBlocked = screen.isOpen();
    fake.otherDialog.close();

    await vi.waitFor(() =>
      expect({ whileBlocked, afterItClosed: openFor(screen) }).toEqual({ whileBlocked: false, afterItClosed: REPO.alpha }),
    );
  });
});

describe('another app dialog replaced by a third one', () => {
  it('opens no setup dialog until the last of them has closed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    const { dialog, screen } = mountDialog(fake);
    fake.otherDialog.open();
    const answered = fake.answered(REPO.alpha);
    void dialog.check(REPO.alpha);
    await answered;

    fake.otherDialog.replace();
    await nextTask();
    const whileReplaced = screen.isOpen();
    fake.otherDialog.close();

    await vi.waitFor(() =>
      expect({ whileReplaced, afterItClosed: openFor(screen) }).toEqual({ whileReplaced: false, afterItClosed: REPO.alpha }),
    );
  });
});

describe('a dialog disposed while it waits for another app dialog', () => {
  it('settles its pending check without the other dialog closing', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    const { dialog } = mountDialog(fake);
    fake.otherDialog.open();
    const answered = fake.answered(REPO.alpha);
    let settled = false;
    void dialog.check(REPO.alpha).then(() => (settled = true));
    await answered;

    dialog.dispose();
    await nextTask();

    expect(settled).toBe(true);
  });

  it('opens nothing once the other dialog closes', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    const { host, dialog } = mountDialog(fake);
    const seen = recordSetupDialogs(host);
    fake.otherDialog.open();
    const answered = fake.answered(REPO.alpha);
    void dialog.check(REPO.alpha);
    await answered;

    dialog.dispose();
    fake.otherDialog.close();
    await nextTask();

    expect(seen()).toEqual([]);
  });
});

describe('checks run one at a time, each repository at most once', () => {
  for (const { door, close } of DOORS) {
    it(`shows back-to-back checks one at a time, in arrival order, the next once the first closes on ${door}`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
      const { dialog, screen } = mountDialog(fake);
      const answered = fake.answered(REPO.alpha);

      void dialog.check(REPO.alpha);
      void dialog.check(REPO.bravo);
      await answered;
      const first = openFor(screen);
      if (screen.isOpen()) close(screen);

      await vi.waitFor(() =>
        expect({ first, second: openFor(screen) }).toEqual({ first: REPO.alpha, second: REPO.bravo }),
      );
    });
  }

  it('shows the first check first even when its status answers after the second one was asked for', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = namedIn(recordSetupDialogs(host));
    const release = fake.hold(REPO.alpha);

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await nextTask();
    release();
    await nextTask();
    if (screen.isOpen()) screen.pressEscape();

    await vi.waitFor(() => expect(seen()).toEqual([REPO.alpha, REPO.bravo]));
  });

  it('raises one popup when the same repository is checked twice before its first status answers', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = namedIn(recordSetupDialogs(host));

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.charlie);
    await nextTask();
    if (screen.isOpen()) screen.pressEscape();

    await vi.waitFor(() => expect(seen()).toEqual([REPO.alpha, REPO.charlie]));
  });

  it('raises no second popup for a repository already checked and shown this session (AC10)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = namedIn(recordSetupDialogs(host));
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);
    screen.pressEscape();

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.charlie);
    await shownFor(screen, REPO.charlie);

    expect(seen()).toEqual([REPO.alpha, REPO.charlie]);
  });

  it('does not check again a repository whose status listed nothing', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, []), repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog, screen } = mountDialog(fake);
    const seen = namedIn(recordSetupDialogs(host));
    const answered = fake.answered(REPO.alpha);
    void dialog.check(REPO.alpha);
    await answered;

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.charlie);
    await shownFor(screen, REPO.charlie);

    expect(seen()).toEqual([REPO.charlie]);
  });

  const FAILED: Array<{ how: string; reply: Parameters<ReturnType<typeof fakeSetupDeps>['answer']>[1] }> = [
    { how: 'answers ok: false', reply: { ok: false, reason: 'scripted status failure' } },
    { how: 'is rejected', reply: { reject: 'scripted invoke rejection' } },
  ];

  for (const { how, reply } of FAILED) {
    it(`a status request that ${how} shows nothing, does not stall the next check, and leaves its repository to be checked again, once`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, reply, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.absent]));
      fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
      const { host, dialog, screen } = mountDialog(fake);
      const seen = namedIn(recordSetupDialogs(host));

      void dialog.check(REPO.alpha);
      void dialog.check(REPO.bravo);
      await shownFor(screen, REPO.bravo);
      screen.pressEscape();
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);
      screen.pressEscape();
      void dialog.check(REPO.alpha);
      void dialog.check(REPO.charlie);
      await shownFor(screen, REPO.charlie);

      expect(seen()).toEqual([REPO.bravo, REPO.alpha, REPO.charlie]);
    });
  }
});

const INSTALL = 'Install/update examples';

describe('the examples entry and Install/update examples (AC12, AC17)', () => {
  it('shows Install/update examples when the examples entry is listed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    expect(screen.hasControl(INSTALL)).toBe(true);
  });

  it('hides Install/update examples when only repository entries are listed (AC12)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.notIgnored]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    expect(screen.hasControl(INSTALL)).toBe(false);
  });

  it('pressing it closes the popup, then opens the install-examples flow (AC17)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.examplesStale]));
    const { dialog, screen } = mountDialog(fake);
    fake.whenInstallOpens(() => ({ popupOpen: screen.isOpen() }));
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(INSTALL).click();

    await vi.waitFor(() =>
      expect({ open: screen.isOpen(), installOpens: fake.installOpens() }).toEqual({
        open: false,
        installOpens: [{ popupOpen: false }],
      }),
    );
  });

  it('closing the popup through it lets a queued check raise its popup (AC11)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.examplesStale]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.alpha);

    screen.control(INSTALL).click();

    await vi.waitFor(() => expect(openFor(screen)).toBe(REPO.bravo));
  });
});

describe('the examples entry after startup', () => {
  /** Runs the startup check of `dir`, outside a git repository with the examples entry listed, and closes its
   *  popup. */
  async function closedStartupPopup(fake: ReturnType<typeof fakeSetupDeps>, dir: string) {
    fake.answer(dir, plainStatus(dir, [ENTRY.examplesStale]));
    const mountedDialog = mountDialog(fake);
    void mountedDialog.dialog.check(dir);
    await vi.waitFor(() => expect(mountedDialog.screen.isOpen()).toBe(true));
    mountedDialog.screen.pressEscape();
    return mountedDialog;
  }

  it('entering a directory that is not a git repository raises no popup, even with the examples entry listed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.bravo, plainStatus(REPO.bravo, [ENTRY.examplesStale]));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog } = await closedStartupPopup(fake, REPO.alpha);
    const seen = namedIn(recordSetupDialogs(host));

    void dialog.check(REPO.bravo);
    void dialog.check(REPO.charlie);

    await vi.waitFor(() => expect(seen()[0]).toBe(REPO.charlie));
  });

  it('entering a new git repository whose status lists only the examples entry raises a popup listing it', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.examplesStale]));
    const { dialog, screen } = await closedStartupPopup(fake, REPO.alpha);

    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.bravo);

    expect(screen.entries()).toHaveLength(1);
  });
});

describe('a popup raised outside a git repository', () => {
  it('names no directory in its title or description', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, plainStatus(REPO.alpha, [ENTRY.examplesStale]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await vi.waitFor(() => expect(screen.isOpen()).toBe(true));

    expect(`${screen.title()} ${screen.description()}`).not.toContain(REPO.alpha);
  });
});

describe('a startup check that failed is still the startup check', () => {
  it('a later check of a directory that is not a git repository raises no popup, even with the examples entry listed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, { reject: 'scripted status failure' });
    fake.answer(REPO.bravo, plainStatus(REPO.bravo, [ENTRY.examplesStale]));
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [ENTRY.malformed]));
    const { host, dialog } = mountDialog(fake);
    const seen = namedIn(recordSetupDialogs(host));

    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    void dialog.check(REPO.charlie);

    await vi.waitFor(() => expect(seen()[0]).toBe(REPO.charlie));
  });
});

const FOR_REPO = "Don't show again for this repo";
const UNTIL_UPDATE = "Don't show again until the app updates";

/** The message the dialog shows for each of `entries` alone, read from a dialog of its own, so a test can tell
 *  which entries remain without pinning their wording. */
async function messagesOf(entries: SetupConditionEntry[]): Promise<string[]> {
  const messages: string[] = [];
  for (const entry of entries) {
    const fake = fakeSetupDeps();
    fake.answer(REPO.charlie, repoStatus(REPO.charlie, [entry]));
    const host = document.body.appendChild(document.createElement('div'));
    const dialog = createSetupCheckDialog(host, fake.deps);
    const screen = setupCheckScreen(host);
    void dialog.check(REPO.charlie);
    await shownFor(screen, REPO.charlie);
    messages.push(...screen.entries());
    dialog.dispose();
    host.remove();
  }
  return messages;
}

const sorted = (values: string[]): string[] => [...values].sort();

/** The name of the dialog control that has focus, or null when focus is on none of them. */
const focusedControl = (screen: ReturnType<typeof setupCheckScreen>): string | null =>
  screen.controls().find((name) => screen.control(name) === document.activeElement) ?? null;

describe('the dismissal controls are offered only for the entries they silence (AC12)', () => {
  const RULES: Array<{ control: string; own: SetupConditionEntry[]; otherOnly: SetupConditionEntry[] }> = [
    { control: FOR_REPO, own: [ENTRY.notIgnored, ENTRY.examplesStale], otherOnly: [ENTRY.examplesStale] },
    { control: UNTIL_UPDATE, own: [ENTRY.absent, ENTRY.examplesStale], otherOnly: [ENTRY.absent, ENTRY.notIgnored] },
  ];

  for (const { control, own, otherOnly } of RULES) {
    it(`shows ${control} when an entry it silences is listed`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, own));
      const { dialog, screen } = mountDialog(fake);

      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      expect(screen.hasControl(control)).toBe(true);
    });

    it(`hides ${control} when only entries it does not silence are listed`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, otherOnly));
      const { dialog, screen } = mountDialog(fake);

      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      expect(screen.hasControl(control)).toBe(false);
    });
  }
});

describe('a dismissal press removes what it silences and keeps the other kind (AC13, AC14)', () => {
  const MIXED: SetupConditionEntry[] = [ENTRY.notIgnored, ENTRY.absent, ENTRY.examplesStale];
  const CASES: Array<{ control: string; dismissal: SetupDismissal; remaining: SetupConditionEntry[]; controls: string[] }> = [
    {
      control: FOR_REPO,
      dismissal: { kind: 'repo', repoKey: REPO.alpha },
      remaining: [ENTRY.examplesStale],
      controls: [INSTALL, UNTIL_UPDATE, 'Close'],
    },
    {
      control: UNTIL_UPDATE,
      dismissal: { kind: 'examples', appVersion: APP_VERSION },
      remaining: [ENTRY.notIgnored, ENTRY.absent],
      controls: [FOR_REPO, 'Close'],
    },
  ];

  for (const { control, dismissal, remaining, controls } of CASES) {
    it(`${control} records its dismissal for the popup's ${dismissal.kind === 'repo' ? 'repository' : 'app version'}, and leaves the other kind listed with its controls and focus on one of them`, async () => {
      const expected = await messagesOf(remaining);
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, MIXED));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      screen.control(control).focus();
      screen.control(control).click();

      await vi.waitFor(() =>
        expect({
          recorded: fake.dismissals(),
          entries: sorted(screen.entries()),
          controls: sorted(screen.controls()),
          focusOnRemainingControl: controls.includes(focusedControl(screen) ?? ''),
        }).toEqual({ recorded: [dismissal], entries: sorted(expected), controls: sorted(controls), focusOnRemainingControl: true }),
      );
    });
  }
});

describe('a dismissal that could not be saved', () => {
  const FAILURES: Array<{ how: string; reply: Parameters<ReturnType<typeof fakeSetupDeps>['answerDismiss']>[0]; reason: string | null }> = [
    { how: 'answers ok: false', reply: { ok: false, reason: 'scripted dismissal write failure' }, reason: 'scripted dismissal write failure' },
    { how: 'is rejected', reply: { reject: 'scripted dismissal invoke rejection' }, reason: null },
  ];

  for (const { how, reply, reason } of FAILURES) {
    it(`keeps every entry and the control to retry, and says why in the dialog's alert, when its save ${how}`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]));
      fake.answerDismiss(reply);
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);
      const before = screen.entries();

      screen.control(FOR_REPO).click();

      await vi.waitFor(() => {
        const alert = screen.alert();
        expect({
          asked: fake.dismissals().length,
          entries: screen.entries(),
          retryable: screen.hasControl(FOR_REPO),
          alerted: reason === null ? alert !== null : (alert ?? '').includes(reason),
        }).toEqual({ asked: 1, entries: before, retryable: true, alerted: true });
      });
    });
  }
});

describe('the last dismissal closes the popup as an accept', () => {
  it('with focus back where the operator was', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]));
    const { dialog, screen } = mountDialog(fake);
    const opener = focusedOpener();
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(FOR_REPO).click();

    await vi.waitFor(() =>
      expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
        open: false,
        focusOnOpener: true,
      }),
    );
  });

  it('so a queued check raises its popup (AC11)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.examplesStale]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.alpha);

    screen.control(UNTIL_UPDATE).click();

    await vi.waitFor(() => expect(openFor(screen)).toBe(REPO.bravo));
  });
});

describe('a dismissal still being saved when the dialog is disposed', () => {
  it('draws nothing in the host once its save answers', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.examplesStale]));
    let answer: (reply: { ok: true }) => void = () => {};
    const saved = new Promise<{ ok: true }>((resolve) => (answer = resolve));
    fake.deps.dismiss = () => saved;
    const { host, dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(FOR_REPO).click();
    dialog.dispose();
    answer({ ok: true });
    await saved;
    await Promise.resolve();

    expect({ open: screen.isOpen(), focusInHost: host.contains(document.activeElement) }).toEqual({
      open: false,
      focusInHost: false,
    });
  });
});

const RUN_SETUP = 'Run setup loop';

describe('Run setup loop is offered only for the entries the setup flow fixes, with the flow installed (AC12, AC18)', () => {
  const RULES: Array<{ when: string; entries: SetupConditionEntry[]; installed: boolean; shown: boolean }> = [
    { when: 'only a not-ignored entry is listed', entries: [ENTRY.notIgnored], installed: true, shown: true },
    { when: 'only an absent capabilities entry is listed', entries: [ENTRY.absent], installed: true, shown: true },
    { when: 'only the examples entry is listed', entries: [ENTRY.examplesStale], installed: true, shown: false },
    {
      when: 'only malformed, confinement and unchecked entries are listed',
      entries: [ENTRY.malformed, ENTRY.confinement, ENTRY.unchecked],
      installed: true,
      shown: false,
    },
    { when: 'the setup flow is not installed', entries: [ENTRY.notIgnored], installed: false, shown: false },
  ];

  for (const { when, entries, installed, shown } of RULES) {
    it(`${shown ? 'shows' : 'hides'} it when ${when}`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, entries, installed));
      const { dialog, screen } = mountDialog(fake);

      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      expect(screen.hasControl(RUN_SETUP)).toBe(shown);
    });
  }
});

describe('pressing Run setup loop (AC18, AC19)', () => {
  /** A popup for alpha offering Run setup loop, with the terminal already moved on to bravo, whose check waits. */
  async function runSetupOffered(fake: ReturnType<typeof fakeSetupDeps>) {
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent], true));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const mountedDialog = mountDialog(fake);
    void mountedDialog.dialog.check(REPO.alpha);
    void mountedDialog.dialog.check(REPO.bravo);
    await shownFor(mountedDialog.screen, REPO.alpha);
    return mountedDialog;
  }

  it("starts the repo-setup flow in the popup's repository, not the one the terminal moved to", async () => {
    const fake = fakeSetupDeps();
    const { screen } = await runSetupOffered(fake);

    screen.control(RUN_SETUP).click();

    await vi.waitFor(() => expect(fake.flows.started()).toEqual({ [REPO.alpha]: REPO_SETUP_FLOW_ID }));
  });

  it('closes the popup once the start has run, and announces nothing itself', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent], true));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();

    await vi.waitFor(() =>
      expect({ open: screen.isOpen(), started: fake.flows.started(), announced: fake.announcements() }).toEqual({
        open: false,
        started: { [REPO.alpha]: REPO_SETUP_FLOW_ID },
        announced: [],
      }),
    );
  });

  const REFUSALS: Array<{ how: string; reply: Parameters<ReturnType<typeof fakeSetupDeps>['flows']['answerSelection']>[0]; reason: string }> = [
    { how: 'is refused because the run has begun', reply: { ok: false, reason: 'scripted begun-run refusal' }, reason: 'scripted begun-run refusal' },
    { how: 'is rejected', reply: { reject: 'scripted selection rejection' }, reason: 'scripted selection rejection' },
  ];

  for (const { how, reply, reason } of REFUSALS) {
    it(`when the selection ${how}, closes the popup, announces why, and starts nothing`, async () => {
      const fake = fakeSetupDeps();
      fake.flows.answerSelection(reply);
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored], true));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      screen.control(RUN_SETUP).click();

      await vi.waitFor(() =>
        expect({
          open: screen.isOpen(),
          announcedReason: fake.announcements().some(({ message }) => message.includes(reason)),
          started: fake.flows.started(),
        }).toEqual({ open: false, announcedReason: true, started: {} }),
      );
    });
  }

  it('closing the popup through it lets a queued check raise its popup (AC11)', async () => {
    const fake = fakeSetupDeps();
    const { screen } = await runSetupOffered(fake);

    screen.control(RUN_SETUP).click();

    await vi.waitFor(() => expect(openFor(screen)).toBe(REPO.bravo));
  });
});

describe('Run setup loop over the real flow strip (AC18)', () => {
  it('opens the step-entry input modal only once the popup has gone, so two modal dialogs are never open, and focus ends in it', async () => {
    const promptView: FlowStateView = {
      stepName: 'setup-entry',
      runStarted: 'started',
      steps: ['setup-entry'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'note', type: 'text' }], bootstrap: '' },
    };
    const idle: FlowStateView = { ...promptView, runStarted: 'never-started', status: 'not_started', prompt: undefined };
    const stripHost = document.body.appendChild(document.createElement('div'));
    const inputHost = document.body.appendChild(document.createElement('div'));
    const inputModal = createFlowInputModal(inputHost);
    const modalsOpenWhenInputOpened: number[] = [];
    const strip = createFlowStrip(stripHost, {
      state: async () => idle,
      start: async () => promptView,
      advance: async () => promptView,
      restart: async () => promptView,
      undo: async () => promptView,
      terminate: async () => idle,
      provideInput: async () => promptView,
      onStateChanged: () => () => {},
      onStatusBar: () => {},
      onPrompt: (prompt, stepName, submit) => {
        if (prompt) modalsOpenWhenInputOpened.push(openModalDialogs(document.body));
        inputModal.render(prompt, stepName, submit);
      },
    });
    strip.onRepoChanged(REPO.alpha);
    const fake = fakeSetupDeps();
    fake.deps.start = (repoKey) => strip.start(repoKey);
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent], true));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();

    try {
      await vi.waitFor(() =>
        expect({ modalsOpenWhenInputOpened, focusInInputModal: inputHost.contains(document.activeElement) }).toEqual({
          modalsOpenWhenInputOpened: [0],
          focusInInputModal: true,
        }),
      );
    } finally {
      strip.dispose();
      inputModal.dispose();
    }
  });
});

describe('Run setup loop with another check queued, over the real flow strip (AC18)', () => {
  it("keeps the queued popup closed until the start's step-entry input modal has opened, so it never opens under it", async () => {
    const promptView: FlowStateView = {
      stepName: 'setup-entry',
      runStarted: 'started',
      steps: ['setup-entry'],
      position: 1,
      total: 1,
      status: 'in_progress',
      prompt: { inputs: [{ name: 'note', type: 'text' }], bootstrap: '' },
    };
    const idle: FlowStateView = { ...promptView, runStarted: 'never-started', status: 'not_started', prompt: undefined };
    let releaseStart: () => void = () => {};
    const startHeld = new Promise<void>((resolve) => (releaseStart = resolve));
    const stripHost = document.body.appendChild(document.createElement('div'));
    const inputHost = document.body.appendChild(document.createElement('div'));
    const inputModal = createFlowInputModal(inputHost);
    const modalsOpenWhenInputOpened: number[] = [];
    const strip = createFlowStrip(stripHost, {
      state: async () => idle,
      start: () => startHeld.then(() => promptView),
      advance: async () => promptView,
      restart: async () => promptView,
      undo: async () => promptView,
      terminate: async () => idle,
      provideInput: async () => promptView,
      onStateChanged: () => () => {},
      onStatusBar: () => {},
      onPrompt: (prompt, stepName, submit) => {
        if (prompt) modalsOpenWhenInputOpened.push(openModalDialogs(document.body));
        inputModal.render(prompt, stepName, submit);
      },
    });
    strip.onRepoChanged(REPO.alpha);
    const fake = fakeSetupDeps();
    fake.deps.start = (repoKey) => strip.start(repoKey);
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent], true));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();
    await vi.waitFor(() => expect(screen.isOpen()).toBe(false));
    releaseStart();

    try {
      await vi.waitFor(() => expect(modalsOpenWhenInputOpened).toEqual([0]));
    } finally {
      strip.dispose();
      inputModal.dispose();
    }
  });
});

describe('Run setup loop after a dismissal rebuilds the popup, with the setup flow installed (AC12, AC18)', () => {
  const MIXED: SetupConditionEntry[] = [ENTRY.notIgnored, ENTRY.absent, ENTRY.examplesStale];
  const CASES: Array<{ press: string; offered: boolean }> = [
    { press: "Don't show again for this repo", offered: false },
    { press: "Don't show again until the app updates", offered: true },
  ];

  for (const { press, offered } of CASES) {
    it(`${offered ? 'keeps' : 'removes'} it once ${press} leaves ${offered ? 'entries the flow fixes' : 'only the examples entry'} listed`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, MIXED, true));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      screen.control(press).click();

      await vi.waitFor(() => expect({ dismissed: screen.hasControl(press), runSetup: screen.hasControl(RUN_SETUP) }).toEqual({ dismissed: false, runSetup: offered }));
    });
  }
});
