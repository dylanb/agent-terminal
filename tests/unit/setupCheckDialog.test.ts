// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetupCheckDialog, type SetupCheckDialog } from '../../src/renderer/src/setupCheckDialog';
import {
  APP_VERSION,
  ENTRY,
  REPO,
  cleanPreview,
  differingPreview,
  fakeSetupDeps,
  installFailed,
  installSucceeded,
  plainStatus,
  repoStatus,
  retiredPreview,
} from '../helpers/setupCheckFixtures';
import type { SetupConditionEntry, SetupDismissal } from '../../src/shared/setupCheck';
import { accessibleName, everyByRole } from '../helpers/byRole';
import { openModalDialogs, recordSetupDialogs, setupCheckScreen } from '../helpers/setupCheckScreen';
import { createSetupFlowRun, type SetupFlowRun } from '../../src/renderer/src/setupFlowRun';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { createFlowInputModal } from '../../src/renderer/src/flowInputModal';
import type { FlowStateView, SetupStatusReply } from '../../src/shared/ipc';

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

  it('reads every listed failure in its accessible description', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.malformed]));
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    const description = screen.description();
    const entries = screen.entries();
    expect({ listed: entries.length, unread: entries.filter((entry) => !description.includes(entry)) }).toEqual({
      listed: 2,
      unread: [],
    });
  });

  it('lands focus on the dialog itself on open, not on one of its controls', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.examplesStale], true));
    const { dialog, screen } = mountDialog(fake);
    focusedOpener();

    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    expect({ focusOnDialog: document.activeElement === screen.dialog(), focusedControl: focusedControl(screen) }).toEqual({
      focusOnDialog: true,
      focusedControl: null,
    });
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

describe('a wait for another app dialog to close', () => {
  it('leaves no subscription to that dialog closing once the popup has opened', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    let live = 0;
    const subscribe = fake.deps.onBlockingDialogClosed;
    fake.deps.onBlockingDialogClosed = (cb) => {
      live += 1;
      const off = subscribe(cb);
      let released = false;
      return () => {
        if (!released) live -= 1;
        released = true;
        off();
      };
    };
    const { dialog, screen } = mountDialog(fake);
    fake.otherDialog.open();
    const answered = fake.answered(REPO.alpha);
    void dialog.check(REPO.alpha);
    await answered;

    fake.otherDialog.close();
    await shownFor(screen, REPO.alpha);

    expect(live).toBe(0);
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

describe('a disposed dialog', () => {
  it('asks for no status when checked', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const asked: string[] = [];
    const status = fake.deps.status;
    fake.deps.status = (repoKey) => {
      asked.push(repoKey);
      return status(repoKey);
    };
    const { dialog } = mountDialog(fake);

    dialog.dispose();
    await dialog.check(REPO.alpha);

    expect(asked).toEqual([]);
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

  it('a check whose status request is rejected settles without rejecting', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, { reject: 'scripted invoke rejection' });
    const { dialog } = mountDialog(fake);

    await expect(dialog.check(REPO.alpha)).resolves.toBeUndefined();
  });

  it('a check that fails while it waits for other dialogs does not stall a later check of another repository', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
    let probeFails = true;
    fake.deps.blockingDialogOpen = () => {
      if (!probeFails) return false;
      probeFails = false;
      throw new Error('scripted blocking-dialog probe failure');
    };
    const { dialog, screen } = mountDialog(fake);

    void dialog.check(REPO.alpha).catch(() => {});
    void dialog.check(REPO.bravo);

    await shownFor(screen, REPO.bravo);
  });

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

  it('closing the popup through it lets a queued check raise its popup (AC11)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.examplesStale]), repoStatus(REPO.alpha, []));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.notIgnored]));
    fake.examples.preview(cleanPreview('pv-queued'));
    fake.examples.install(installSucceeded());
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.alpha);

    screen.control(INSTALL).click();
    await settle();

    expect.soft(fake.examples.requests(), 'the install the press asked for').toEqual([
      { previewId: 'pv-queued', replace: [], removeRetired: false },
    ]);
    expect.soft(fake.statusRequests(), 'alpha re-read before bravo is checked').toEqual([REPO.alpha, REPO.alpha, REPO.bravo]);
    expect.soft(openFor(screen), 'the queued check raised its popup').toBe(REPO.bravo);
  });
});

const REPLACE = 'Install';
const BACK = 'Back to the list';

/** Lets every reply the fake scripted run through the popup; they all settle within a task each. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await nextTask();
}

const reading = (screen: ReturnType<typeof setupCheckScreen>) =>
  screen.isOpen()
    ? {
        entries: screen.entries(),
        controls: screen.controls(),
        alert: screen.alert(),
        title: screen.title(),
        description: screen.description(),
        focusInside: screen.dialog().contains(document.activeElement),
        checkboxes: screen.checkboxes(),
      }
    : null;

/** Presses the control named `name` when the popup shows it; reports whether it did, never throws. */
function pressIfShown(screen: ReturnType<typeof setupCheckScreen>, name: string): boolean {
  if (!screen.isOpen() || !screen.hasControl(name)) return false;
  screen.control(name).click();
  return true;
}

describe('Install/update examples runs the install inside the popup (AC2, AC3, AC4, AC5, AC9, AC10, AC11)', () => {
  const MIXED = [ENTRY.notIgnored, ENTRY.examplesStale];

  /** An open popup for alpha listing `MIXED`, with what it listed read back. */
  async function openMixed(fake: ReturnType<typeof fakeSetupDeps>, ...reads: Array<SetupStatusReply | { reject: string }>) {
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, MIXED), ...reads);
    const mountedDialog = mountDialog(fake);
    void mountedDialog.dialog.check(REPO.alpha);
    await shownFor(mountedDialog.screen, REPO.alpha);
    const before = {
      entries: mountedDialog.screen.entries(),
      title: mountedDialog.screen.title(),
      description: mountedDialog.screen.description(),
    };
    return { ...mountedDialog, before };
  }

  it('installs a preview that needs no choice at once, then lists what the repository still fails (AC2)', async () => {
    const fake = fakeSetupDeps();
    fake.examples.preview(cleanPreview('pv-clean'));
    fake.examples.install(installSucceeded());
    const { screen, before } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));

    screen.control(INSTALL).click();
    await settle();

    expect.soft(fake.examples.requests(), 'the install request').toEqual([
      { previewId: 'pv-clean', replace: [], removeRetired: false },
    ]);
    expect.soft(fake.statusRequests(), 'the status re-read names the popup repository').toEqual([REPO.alpha, REPO.alpha]);
    expect.soft(openModalDialogs(document.body), 'the popup is the only open dialog').toBe(1);
    const read = reading(screen);
    expect.soft(read?.entries, 'the re-read entries are listed').toEqual([before.entries[0]]);
    expect.soft(read?.controls.includes(INSTALL), 'Install/update examples is gone').toBe(false);
    expect.soft(read?.controls.includes(UNTIL_UPDATE), "Don't show again until the app updates is gone").toBe(false);
    expect.soft(read?.controls.includes(FOR_REPO), "Don't show again for this repo stays").toBe(true);
    expect.soft(read !== null && screen.dialog().contains(document.activeElement), 'focus is inside the popup').toBe(true);
  });

  describe('a preview with differing files asks the replace question inside the popup (AC3)', () => {
    const differing = differingPreview('pv-diff', ['flow', 'commands']);

    it('switches the dialog to the question: another name and description, focus inside, nothing installed', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(differing);
      const { screen, before } = await openMixed(fake);

      screen.control(INSTALL).click();
      await settle();

      const read = reading(screen);
      expect.soft(openModalDialogs(document.body), 'the popup is the only open dialog').toBe(1);
      expect.soft(read?.title, 'the name comes from the question').not.toBe(before.title);
      expect.soft(read?.title, 'the popup is open and named').toBeTruthy();
      expect.soft(read?.description, 'the description comes from the question').not.toBe(before.description);
      expect.soft(read?.description, 'the popup is open and described').toBeTruthy();
      expect.soft(read?.focusInside, 'focus is inside the question').toBe(true);
      expect.soft(read?.controls, 'the question offers Install, Back to the list and Close').toEqual(
        expect.arrayContaining([REPLACE, BACK, 'Close']),
      );
      expect.soft(fake.examples.requests(), 'nothing is installed while the question shows').toEqual([]);
    });

    it('Back to the list installs nothing and shows the list it showed before', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(differing);
      const { screen, before } = await openMixed(fake);
      screen.control(INSTALL).click();
      await settle();

      expect.soft(pressIfShown(screen, BACK), 'the question offers Back to the list').toBe(true);
      await settle();

      const read = reading(screen);
      expect.soft(fake.examples.requests(), 'no install request').toEqual([]);
      expect.soft(fake.statusRequests(), 'no re-read').toEqual([REPO.alpha]);
      expect.soft(read?.entries, 'lists what it listed before').toEqual(before.entries);
      expect.soft(read?.title, 'the name is the list name again').toBe(before.title);
      expect.soft(read?.description, 'the description is the list description again').toBe(before.description);
      expect.soft(read?.focusInside, 'focus is inside the popup').toBe(true);
    });

    it('ticking every replacement and pressing Install sends every differing destination, then lists the re-read', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(differing);
      fake.examples.install(installSucceeded());
      const { screen, before } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      screen.control(INSTALL).click();
      await settle();

      const boxes = reading(screen)?.checkboxes ?? [];
      expect.soft(boxes.length, 'one checkbox per differing destination').toBe(2);
      for (const box of boxes) box.click();
      expect.soft(pressIfShown(screen, REPLACE), 'the question offers Install').toBe(true);
      await settle();

      expect.soft(fake.examples.requests().map((r) => ({ ...r, replace: [...r.replace].sort() })), 'the install request').toEqual([
        { previewId: 'pv-diff', replace: ['commands', 'flow'], removeRetired: false },
      ]);
      const read = reading(screen);
      expect.soft(read?.entries, 'the re-read entries are listed').toEqual([before.entries[0]]);
      expect.soft(read?.controls.includes(INSTALL), 'Install/update examples is gone').toBe(false);
      expect.soft(openModalDialogs(document.body), 'the popup is the only open dialog').toBe(1);
    });

    it('Install with nothing ticked sends no replacement; the examples entry the re-read keeps is listed beside the others', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(differing);
      fake.examples.install(installSucceeded());
      const { screen, before } = await openMixed(fake, repoStatus(REPO.alpha, MIXED));
      screen.control(INSTALL).click();
      await settle();

      expect.soft(pressIfShown(screen, REPLACE), 'the question offers Install').toBe(true);
      await settle();

      expect.soft(fake.examples.requests(), 'the install request').toEqual([{ previewId: 'pv-diff', replace: [], removeRetired: false }]);
      const read = reading(screen);
      expect.soft(read?.entries, 'both entries are listed').toEqual(before.entries);
      expect.soft(read?.controls.includes(INSTALL), 'Install/update examples is offered again').toBe(true);
      expect.soft(read?.title, 'the name is the list name again').toBe(before.title);
      expect.soft(read?.description, 'the description is the list description again').toBe(before.description);
      expect.soft(read?.focusInside, 'focus is inside the popup').toBe(true);
    });

    it('a retired example the operator ticks is sent as removeRetired', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(retiredPreview('pv-retired'));
      fake.examples.install(installSucceeded());
      const { screen } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      screen.control(INSTALL).click();
      await settle();

      const boxes = reading(screen)?.checkboxes ?? [];
      expect.soft(boxes.length, 'one checkbox for the retired examples').toBe(1);
      boxes[0]?.click();
      expect.soft(pressIfShown(screen, REPLACE), 'the question offers Install').toBe(true);
      await settle();

      expect.soft(fake.examples.requests(), 'the install request').toEqual([
        { previewId: 'pv-retired', replace: [], removeRetired: true },
      ]);
    });
  });

  describe('closing the question ends the popup for the session (AC9)', () => {
    for (const { door, close } of DOORS) {
      it(`${door} installs nothing, and a later check of the repository opens nothing`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(differingPreview('pv-door', ['flow']));
        const { dialog, screen } = await openMixed(fake, repoStatus(REPO.alpha, MIXED));
        screen.control(INSTALL).click();
        await settle();
        expect.soft(screen.isOpen() && screen.hasControl(BACK), 'the replace question is showing').toBe(true);

        if (screen.isOpen()) close(screen);
        await settle();

        expect.soft(screen.isOpen(), 'the popup ended').toBe(false);
        expect.soft(fake.examples.requests(), 'no install request').toEqual([]);
        void dialog.check(REPO.alpha);
        await settle();
        expect.soft(screen.isOpen(), 'nothing opens again this session').toBe(false);
      });
    }
  });

  describe('while an install request is pending', () => {
    it('Escape and the scrim leave the popup open; once it answers, Escape closes it', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-pending'));
      fake.examples.install(installSucceeded());
      const release = fake.examples.holdInstall();
      const { screen } = await openMixed(fake, repoStatus(REPO.alpha, MIXED));
      screen.control(INSTALL).click();
      await settle();
      expect.soft(fake.examples.requests().length, 'the install is pending').toBe(1);

      if (screen.isOpen()) screen.pressEscape();
      await settle();
      expect.soft(screen.isOpen(), 'Escape leaves it open').toBe(true);
      if (screen.isOpen()) screen.pressScrim();
      await settle();
      expect.soft(screen.isOpen(), 'the scrim leaves it open').toBe(true);

      release();
      await settle();
      expect.soft(screen.isOpen(), 'it lists the re-read once answered').toBe(true);
      if (screen.isOpen()) screen.pressEscape();
      await settle();
      expect.soft(screen.isOpen(), 'Escape closes it once the install answered').toBe(false);
    });
  });

  describe('Run setup loop follows the re-read (AC5)', () => {
    for (const fixable of [ENTRY.absent, ENTRY.notIgnored]) {
      it(`is offered when the re-read reports the setup flow installed and lists ${fixable.condition}/${fixable.failure}`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-run'));
        fake.examples.install(installSucceeded());
        fake.answer(REPO.alpha, repoStatus(REPO.alpha, [fixable, ENTRY.examplesStale], false), repoStatus(REPO.alpha, [fixable], true));
        const { dialog, screen } = mountDialog(fake);
        void dialog.check(REPO.alpha);
        await shownFor(screen, REPO.alpha);
        expect(screen.hasControl(RUN_SETUP), 'not offered before the install').toBe(false);

        screen.control(INSTALL).click();
        await settle();

        expect.soft(reading(screen)?.controls.includes(RUN_SETUP), 'offered after the re-read').toBe(true);
      });
    }

    it('is not offered when the re-read reports it installed but lists nothing it fixes', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-run-none'));
      fake.examples.install(installSucceeded());
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.malformed, ENTRY.examplesStale], false), repoStatus(REPO.alpha, [ENTRY.malformed], true));
      const { dialog, screen } = mountDialog(fake);
      void dialog.check(REPO.alpha);
      await shownFor(screen, REPO.alpha);

      screen.control(INSTALL).click();
      await settle();

      const read = reading(screen);
      expect.soft(read?.entries.length, 'the re-read entry is listed').toBe(1);
      expect.soft(read?.controls.includes(RUN_SETUP), 'not offered').toBe(false);
    });
  });

  describe('failures keep the popup open with the reason (U6)', () => {
    const REASON = 'scripted-reason-zq';

    for (const reply of [{ ok: false as const, error: REASON }, { reject: REASON }]) {
      it(`a failed preview (${'reject' in reply ? 'rejected' : 'refused'}) keeps the previous entries and shows why`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(reply);
        const { screen, before } = await openMixed(fake);

        screen.control(INSTALL).click();
        await settle();

        const read = reading(screen);
        expect.soft(fake.examples.previews(), 'a preview was requested').toBe(1);
        expect.soft(read?.entries, 'the previous entries').toEqual(before.entries);
        expect.soft(read?.alert ?? '', 'the reason is shown').toContain(REASON);
        expect.soft(fake.examples.requests(), 'nothing installed').toEqual([]);
      });
    }

    for (const reply of [installFailed(REASON), { reject: REASON }]) {
      it(`a failed install (${'reject' in reply ? 'rejected' : 'refused'}) still re-reads and lists what it reports, with the reason`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-fail'));
        fake.examples.install(reply);
        const { screen, before } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.examplesStale]));

        screen.control(INSTALL).click();
        await settle();

        const read = reading(screen);
        expect.soft(fake.statusRequests(), 'the status was re-read').toEqual([REPO.alpha, REPO.alpha]);
        expect.soft(read?.entries, 'what the re-read reports').toEqual([before.entries[1]]);
        expect.soft(read?.alert ?? '', 'the reason is shown').toContain(REASON);
      });
    }

    for (const reply of [{ ok: false as const, reason: REASON } as SetupStatusReply, { reject: REASON }]) {
      it(`a failed re-read (${'reject' in reply ? 'rejected' : 'refused'}) keeps the previous entries and shows why`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-reread'));
        fake.examples.install(installSucceeded());
        const { screen, before } = await openMixed(fake, reply);

        screen.control(INSTALL).click();
        await settle();

        const read = reading(screen);
        expect.soft(fake.statusRequests(), 'the status was re-read').toEqual([REPO.alpha, REPO.alpha]);
        expect.soft(read?.entries, 'the previous entries').toEqual(before.entries);
        expect.soft(read?.alert ?? '', 'the reason is shown').toContain(REASON);
      });
    }
  });

  it('keeps the popup naming its own repository when the terminal checks another one meanwhile (AC11)', async () => {
    const fake = fakeSetupDeps();
    fake.examples.preview(cleanPreview('pv-eleven'));
    fake.examples.install(installSucceeded());
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const release = fake.examples.holdInstall();
    const { dialog, screen } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    screen.control(INSTALL).click();
    await settle();
    void dialog.check(REPO.bravo);
    await settle();
    expect.soft(fake.examples.requests().length, 'the install is pending').toBe(1);

    release();
    await settle();

    expect.soft(fake.statusRequests().slice(0, 2), 'the re-read names the popup repository').toEqual([REPO.alpha, REPO.alpha]);
    expect.soft(openFor(screen), 'the popup still names its repository').toBe(REPO.alpha);
    expect.soft(pressIfShown(screen, FOR_REPO), "the popup offers Don't show again for this repo").toBe(true);
    await settle();
    expect.soft(fake.dismissals(), "Don't show again for this repo sends the popup repository").toEqual([{ kind: 'repo', repoKey: REPO.alpha }]);
    await vi.waitFor(() => expect(openFor(screen), 'the other repository opens once this one ended').toBe(REPO.bravo));
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
  const FAILURES: Array<{ how: string; reply: Parameters<ReturnType<typeof fakeSetupDeps>['answerDismiss']>[0]; reason: string }> = [
    { how: 'answers ok: false', reply: { ok: false, reason: 'scripted dismissal write failure' }, reason: 'scripted dismissal write failure' },
    { how: 'is rejected', reply: { reject: 'scripted dismissal invoke rejection' }, reason: 'scripted dismissal invoke rejection' },
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

      await vi.waitFor(() =>
        expect({
          asked: fake.dismissals().length,
          entries: screen.entries(),
          retryable: screen.hasControl(FOR_REPO),
          alerted: (screen.alert() ?? '').includes(reason),
        }).toEqual({ asked: 1, entries: before, retryable: true, alerted: true }),
      );
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

/** The text each `role="alert"` element inside `host` is given after the host already holds it, read from the
 *  mutation records so a line written before its card entered the page is not counted. Call the returned function
 *  to read it. */
function alertTextsWrittenIn(host: HTMLElement): () => string[] {
  const written: string[] = [];
  const isAlert = (node: Node | null): boolean => node instanceof Element && node.getAttribute('role') === 'alert';
  const take = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (record.type === 'characterData' && isAlert(record.target.parentNode)) written.push(record.target.textContent ?? '');
      if (record.type === 'childList' && isAlert(record.target)) written.push(record.target.textContent ?? '');
    }
  };
  const observer = new MutationObserver(take);
  observer.observe(host, { childList: true, subtree: true, characterData: true });
  return () => {
    take(observer.takeRecords());
    return [...written];
  };
}

describe('pressing Run setup loop (AC6, AC7, AC8, AC10, AC11)', () => {
  const FIXED_AND_EXAMPLES = [ENTRY.notIgnored, ENTRY.absent, ENTRY.examplesStale];

  /** A popup for alpha offering Run setup loop, with the terminal already moved on to bravo, whose check waits. */
  async function runSetupOffered(fake: ReturnType<typeof fakeSetupDeps>, entries: SetupConditionEntry[] = [ENTRY.notIgnored, ENTRY.absent]) {
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, entries, true));
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

    await vi.waitFor(() => expect(fake.setupFlow.runs()).toEqual([REPO.alpha]));
  });

  it('steps aside while the start runs, then comes back listing only the examples entry, with focus on one of its controls (AC6)', async () => {
    const expected = await messagesOf([ENTRY.examplesStale]);
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
    const release = fake.setupFlow.hold();
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();
    await settle();
    expect.soft(fake.setupFlow.runs(), 'the start asked for the popup repository').toEqual([REPO.alpha]);
    expect.soft(screen.isOpen(), 'the popup has stepped aside while the start runs').toBe(false);
    release();
    await settle();

    const read = reading(screen);
    expect.soft(read?.entries, 'the popup came back listing only the examples entry').toEqual(expected);
    expect.soft(read !== null && focusedControl(screen) !== null, 'focus is on one of its controls').toBe(true);
    expect.soft(openModalDialogs(document.body), 'the popup is the only open dialog').toBe(1);
  });

  it('ends once the start has run when only entries the setup flow fixes were listed, and does not come back (AC7)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent], true));
    const { host, dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);
    const seen = recordSetupDialogs(host);

    screen.control(RUN_SETUP).click();
    await settle();

    expect({ open: screen.isOpen(), runs: fake.setupFlow.runs(), returned: seen() }).toEqual({
      open: false,
      runs: [REPO.alpha],
      returned: [],
    });
  });

  it('when the setup flow could not run, the popup comes back with every entry and the reason in its error line (AC8)', async () => {
    const reason = 'scripted begun-run refusal';
    const fake = fakeSetupDeps();
    fake.setupFlow.answer({ ok: false, reason });
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
    const { host, dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);
    const before = reading(screen);
    const writtenToAlerts = alertTextsWrittenIn(host);

    screen.control(RUN_SETUP).click();
    await settle();

    const read = reading(screen);
    expect.soft(read?.entries, 'every entry it listed before is listed').toEqual(before?.entries);
    expect.soft(read?.controls, 'every control it offered before is offered, so the operator can retry').toEqual(before?.controls);
    expect.soft(read?.alert?.includes(reason), 'the reason is in its error line').toBe(true);
    expect.soft(writtenToAlerts().some((text) => text.includes(reason)), 'the reason was written to the alert after the card was in the page').toBe(true);
    expect.soft(read?.focusInside, 'focus is inside the popup').toBe(true);
    expect.soft(openModalDialogs(document.body), 'no other dialog is open').toBe(1);
  });

  it("draws nothing in the host when the setup flow's refusal lands after the dialog was disposed", async () => {
    const reason = 'scripted begun-run refusal';
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored], true));
    let refuse: (run: SetupFlowRun) => void = () => {};
    const started = new Promise<SetupFlowRun>((resolve) => (refuse = resolve));
    let asked = false;
    fake.deps.runSetupFlow = () => {
      asked = true;
      return started;
    };
    const { host, dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);
    screen.control(RUN_SETUP).click();
    await vi.waitFor(() => expect(asked).toBe(true));

    dialog.dispose();
    refuse({ ok: false, reason });
    await started;
    await nextTask();

    expect({
      open: screen.isOpen(),
      focusInHost: host.contains(document.activeElement),
      drewReason: (host.textContent ?? '').includes(reason),
    }).toEqual({ open: false, focusInHost: false, drewReason: false });
  });

  it('with only entries the setup flow fixes listed, the queued check raises its popup once the start has run (AC7, AC11)', async () => {
    const fake = fakeSetupDeps();
    const { screen } = await runSetupOffered(fake);

    screen.control(RUN_SETUP).click();

    await vi.waitFor(() => expect(openFor(screen)).toBe(REPO.bravo));
  });

  it('with the examples entry listed, the queued check raises its popup only once the operator closes this one (AC6, AC11)', async () => {
    const fake = fakeSetupDeps();
    const { screen } = await runSetupOffered(fake, FIXED_AND_EXAMPLES);

    screen.control(RUN_SETUP).click();
    await settle();

    expect.soft(openFor(screen), 'the popup that is still open names its own repository').toBe(REPO.alpha);
    if (openFor(screen) === REPO.alpha) screen.control('Close').click();
    await settle();
    expect.soft(openFor(screen), 'the queued check raised its popup after this one was closed').toBe(REPO.bravo);
  });

  it('keeps the entries the setup flow fixed off the list after a later Install/update examples re-read, and does not offer Run setup loop again (AC6)', async () => {
    const expectedAfterStart = await messagesOf([ENTRY.examplesStale, ENTRY.malformed]);
    const expectedAfterInstall = await messagesOf([ENTRY.malformed]);
    const fake = fakeSetupDeps();
    fake.answer(
      REPO.alpha,
      repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale, ENTRY.malformed], true),
      repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent, ENTRY.malformed], true),
    );
    fake.examples.preview(cleanPreview('pv-after-start'));
    fake.examples.install(installSucceeded());
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();
    await settle();
    expect.soft(reading(screen)?.entries, 'the start left the examples entry and the entry it does not fix').toEqual(expectedAfterStart);
    expect.soft(pressIfShown(screen, INSTALL), 'the popup offers Install/update examples after the start').toBe(true);
    await settle();

    const read = reading(screen);
    expect.soft(read?.entries, 'the re-read entries the setup flow fixes stay off the list').toEqual(expectedAfterInstall);
    expect.soft(read?.controls.includes(RUN_SETUP), 'Run setup loop is not offered again').toBe(false);
  });

  it('keeps naming and acting on its own repository when the terminal checks another one while the start is pending (AC11)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale], true));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const release = fake.setupFlow.hold();
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();
    await settle();
    void dialog.check(REPO.bravo);
    await settle();
    release();
    await settle();

    const namedWhenBack = openFor(screen);
    expect.soft(namedWhenBack, 'the popup that came back names its original repository').toBe(REPO.alpha);
    if (namedWhenBack === REPO.alpha) pressIfShown(screen, UNTIL_UPDATE);
    await settle();
    expect.soft(fake.dismissals(), "its Don't show again until the app updates sends its dismissal").toEqual([
      { kind: 'examples', appVersion: APP_VERSION },
    ]);
    expect.soft(openFor(screen), 'the other repository opened once this one ended').toBe(REPO.bravo);
  });
});

describe('Run setup loop over the real flow strip (AC6, AC10, AC18)', () => {
  it('opens the step-entry input modal with no other modal open, and the popup comes back listing only the examples entry once it has gone', async () => {
    const expected = await messagesOf([ENTRY.examplesStale]);
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
    const fake = fakeSetupDeps();
    const popupHost = document.body.appendChild(document.createElement('div'));
    const popupScreen = setupCheckScreen(popupHost);
    const modalsOpenWhenInputOpened: number[] = [];
    const popupOpenWhenInputOpened: boolean[] = [];
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
        if (prompt) {
          modalsOpenWhenInputOpened.push(openModalDialogs(document.body));
          popupOpenWhenInputOpened.push(popupScreen.isOpen());
        }
        inputModal.render(prompt, stepName, submit);
      },
    });
    strip.onRepoChanged(REPO.alpha);
    fake.deps.runSetupFlow = createSetupFlowRun({ setActiveFlow: async () => ({ ok: true }), start: (repoKey) => strip.start(repoKey) });
    fake.deps.blockingDialogOpen = () => openModalDialogs(inputHost) > 0;
    const inputModalWatcher = new MutationObserver(() => {
      if (openModalDialogs(inputHost) === 0) fake.otherDialog.replace();
    });
    inputModalWatcher.observe(inputHost, { childList: true, subtree: true });
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale], true));
    const dialog = createSetupCheckDialog(popupHost, fake.deps);
    mounted.push(dialog);
    void dialog.check(REPO.alpha);
    await shownFor(popupScreen, REPO.alpha);

    try {
      popupScreen.control(RUN_SETUP).click();
      await settle();
      expect.soft(modalsOpenWhenInputOpened, 'no other modal was open when the input modal opened').toEqual([0]);
      expect.soft(popupOpenWhenInputOpened, 'the popup was not open when the input modal opened').toEqual([false]);
      expect.soft(popupScreen.isOpen(), 'the popup stays away while the input modal is open').toBe(false);
      expect.soft(inputHost.contains(document.activeElement), 'focus is in the input modal').toBe(true);

      const cancel = everyByRole(inputHost, 'button').find((button) => accessibleName(button) === 'Cancel');
      expect.soft(cancel, 'the input modal offers Cancel').toBeDefined();
      cancel?.click();
      await settle();

      const read = reading(popupScreen);
      expect.soft(read?.entries, 'the popup came back listing only the examples entry').toEqual(expected);
      expect.soft(read !== null && focusedControl(popupScreen) !== null, 'focus is on one of its controls').toBe(true);
      expect.soft(openModalDialogs(document.body), 'the popup is the only open dialog').toBe(1);
    } finally {
      inputModalWatcher.disconnect();
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
    fake.deps.runSetupFlow = createSetupFlowRun({ setActiveFlow: async () => ({ ok: true }), start: (repoKey) => strip.start(repoKey) });
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent], true));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const { dialog, screen } = mountDialog(fake);
    void dialog.check(REPO.alpha);
    void dialog.check(REPO.bravo);
    await shownFor(screen, REPO.alpha);

    screen.control(RUN_SETUP).click();
    await vi.waitFor(() => expect(screen.isOpen()).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 0));
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
