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
import { openModalDialogs, setupCheckScreen, setupNeededButton } from '../helpers/setupCheckScreen';
import { createSetupFlowRun } from '../../src/renderer/src/setupFlowRun';
import { createFlowStrip } from '../../src/renderer/src/flowStrip';
import { createFlowInputModal } from '../../src/renderer/src/flowInputModal';
import type { FlowStateView, SetupStatusReply } from '../../src/shared/ipc';

// The setup check shows a setup needed button while the terminal's directory fails a condition; pressing it opens
// the popup, which lists each condition in plain words, one message per failure kind.

const mounted: SetupCheckDialog[] = [];

/** Presses the setup needed button the way the operator does, with focus on it; fails when it is not shown. */
function pressSetupNeeded(buttonHost: HTMLElement): HTMLElement {
  const button = setupNeededButton(buttonHost);
  expect(button, 'the setup needed button is shown').not.toBeNull();
  button!.focus();
  button!.click();
  return button!;
}

function mountDialog(fake: ReturnType<typeof fakeSetupDeps>, host: HTMLElement = document.body.appendChild(document.createElement('div'))) {
  const buttonHost = document.body.appendChild(document.createElement('div'));
  const dialog = createSetupCheckDialog({ button: buttonHost, dialog: host }, fake.deps);
  mounted.push(dialog);
  const screen = setupCheckScreen(host);
  /** Checks `repoKey`, presses the button it shows, and settles once the popup names it; returns the button. */
  const raise = async (repoKey: string): Promise<HTMLElement> => {
    await dialog.check(repoKey);
    const button = pressSetupNeeded(buttonHost);
    await shownFor(screen, repoKey);
    return button;
  };
  return { host, buttonHost, dialog, screen, raise };
}

/** Waits until the open dialog is the one raised for `repoKey`. */
const shownFor = (screen: ReturnType<typeof setupCheckScreen>, repoKey: string): Promise<void> =>
  vi.waitFor(() => {
    expect(screen.isOpen(), `a setup dialog is open for ${repoKey}`).toBe(true);
    expect(`${screen.title()} ${screen.description()}`).toContain(repoKey);
  });

async function openPopup(fake: ReturnType<typeof fakeSetupDeps>) {
  const mountedDialog = mountDialog(fake);
  const { screen, raise } = mountedDialog;
  const opener = await raise(REPO.alpha);
  const before = { entries: screen.entries(), controls: screen.controls(), title: screen.title(), description: screen.description() };
  return { ...mountedDialog, opener, before };
}

beforeEach(() => document.body.replaceChildren());
afterEach(() => {
  for (const dialog of mounted.splice(0)) dialog.dispose();
});

describe('a check whose status lists conditions', () => {
  it('opens a dialog naming the repository with one entry per listed condition', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]));
    const { screen } = await openPopup(fake);

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
      const { screen, raise } = mountDialog(fake);
      await raise(REPO.bravo);
      messages.push(...screen.entries());
    }

    expect(
      { count: messages.length, distinct: new Set(messages.filter((m) => m.length > 0)).size },
      `messages: ${JSON.stringify(messages)}`,
    ).toEqual({ count: kinds.length, distinct: kinds.length });
  });
});

describe('the setup needed button', () => {
  it('shows while the status lists a condition, and no popup opens until it is pressed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
    const { buttonHost, dialog, screen } = mountDialog(fake);

    await dialog.check(REPO.alpha);
    await settle();

    expect({ button: setupNeededButton(buttonHost) !== null, open: screen.isOpen() }).toEqual({ button: true, open: false });
  });

  it('does not open the popup when an agent starts at the prompt', async () => {
    const fake = fakeSetupDeps();
    fake.agent.set('absent');
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent], true));
    const { dialog, screen } = mountDialog(fake);
    await dialog.check(REPO.alpha);

    fake.agent.set('busy');
    fake.agent.set('idle');
    await settle();

    expect(screen.isOpen()).toBe(false);
  });

  const NOTHING: Array<{ how: string; reply: Parameters<ReturnType<typeof fakeSetupDeps>['answer']>[1] }> = [
    { how: 'lists nothing', reply: repoStatus(REPO.alpha, []) },
    { how: 'answers ok: false', reply: { ok: false, reason: 'scripted status failure' } },
    { how: 'is rejected', reply: { reject: 'scripted invoke rejection' } },
  ];

  for (const { how, reply } of NOTHING) {
    it(`is not shown when the status request ${how}`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, reply);
      const { buttonHost, dialog } = mountDialog(fake);

      await expect(dialog.check(REPO.alpha)).resolves.toBeUndefined();

      expect(setupNeededButton(buttonHost)).toBeNull();
    });
  }

  it('goes when the terminal moves to a directory whose status lists nothing, and comes back on return', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, []));
    const { buttonHost, dialog } = mountDialog(fake);
    await dialog.check(REPO.alpha);

    await dialog.check(REPO.bravo);
    const inBravo = setupNeededButton(buttonHost) !== null;
    await dialog.check(REPO.alpha);

    expect({ inBravo, backInAlpha: setupNeededButton(buttonHost) !== null }).toEqual({ inBravo: false, backInAlpha: true });
  });

  it('follows the directory the terminal is in now when an earlier status answers late', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, []));
    const { buttonHost, dialog } = mountDialog(fake);
    const release = fake.hold(REPO.alpha);
    const first = dialog.check(REPO.alpha);
    await dialog.check(REPO.bravo);

    release();
    await first;

    expect(setupNeededButton(buttonHost)).toBeNull();
  });

  it("opens the popup for the directory the terminal is in now", async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const { buttonHost, dialog, screen } = mountDialog(fake);
    await dialog.check(REPO.alpha);
    await dialog.check(REPO.bravo);

    pressSetupNeeded(buttonHost);

    await shownFor(screen, REPO.bravo);
  });

  it('closing the popup re-reads the status: the button stays while it lists something and goes once it lists nothing', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, []));
    const { buttonHost, screen, raise } = mountDialog(fake);
    await raise(REPO.alpha);
    screen.control('Close').click();
    await settle();
    const afterFirst = setupNeededButton(buttonHost) !== null;

    pressSetupNeeded(buttonHost);
    screen.control('Close').click();
    await settle();

    expect({ afterFirst, afterSecond: setupNeededButton(buttonHost) !== null, reads: fake.statusRequests().length }).toEqual({
      afterFirst: true,
      afterSecond: false,
      reads: 3,
    });
  });

  it('lands focus through onFocusLost when it goes while it has focus', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]), repoStatus(REPO.alpha, []));
    const { screen, raise } = mountDialog(fake);
    const landing = document.body.appendChild(document.createElement('button'));
    landing.textContent = 'landing';
    fake.landFocusOn(landing);
    await raise(REPO.alpha);

    screen.control('Close').click();
    await settle();

    expect(document.activeElement).toBe(landing);
  });

  it('is removed when the dialog is disposed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { buttonHost, dialog } = mountDialog(fake);
    await dialog.check(REPO.alpha);

    dialog.dispose();

    expect(setupNeededButton(buttonHost)).toBeNull();
  });
});

/** Runs every microtask the fake status replies queue, which all settle before the next task. */
const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const DOORS: Array<{ door: string; close: (screen: ReturnType<typeof setupCheckScreen>) => void }> = [
  { door: 'Close', close: (screen) => screen.control('Close').click() },
  { door: 'Escape', close: (screen) => screen.pressEscape() },
  { door: 'a scrim click', close: (screen) => screen.pressScrim() },
];

describe('the popup is a modal dialog (AC11)', () => {
  it('is announced as a modal dialog with its title and description, and takes focus on open', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { screen, raise } = mountDialog(fake);

    await raise(REPO.alpha);

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
    const { screen } = await openPopup(fake);

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
    const { screen, raise } = mountDialog(fake);

    await raise(REPO.alpha);

    expect({ focusOnDialog: document.activeElement === screen.dialog(), focusedControl: focusedControl(screen) }).toEqual({
      focusOnDialog: true,
      focusedControl: null,
    });
  });

  for (const { door, close } of DOORS) {
    it(`closes on ${door}, with focus back on the setup needed button`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored]), repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      const { screen, raise } = mountDialog(fake);
      const opener = await raise(REPO.alpha);

      close(screen);

      expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
        open: false,
        focusOnOpener: true,
      });
    });
  }

  it('lands focus through onFocusLost when the button left the page while the dialog was open', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.malformed]));
    const { screen, raise } = mountDialog(fake);
    const landing = document.body.appendChild(document.createElement('button'));
    landing.textContent = 'landing';
    fake.landFocusOn(landing);
    const opener = await raise(REPO.alpha);
    opener.remove();

    screen.pressEscape();

    expect(document.activeElement).toBe(landing);
  });

  it('dispose() removes the dialog without moving focus back to the opener', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent]));
    const { dialog, screen, raise } = mountDialog(fake);
    const opener = await raise(REPO.alpha);

    dialog.dispose();

    expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
      open: false,
      focusOnOpener: false,
    });
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
      fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.unchecked]), repoStatus(REPO.bravo, [ENTRY.unchecked]));
      const { screen, raise } = mountDialog(fake, host);
      const opener = await raise(REPO.bravo);

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

const INSTALL = 'Install/update examples';

describe('the examples entry and Install/update examples (AC12, AC17)', () => {
  it('shows Install/update examples when the examples entry is listed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale]));
    const { screen } = await openPopup(fake);

    expect(screen.hasControl(INSTALL)).toBe(true);
  });

  it('hides Install/update examples when only repository entries are listed (AC12)', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.notIgnored]));
    const { screen } = await openPopup(fake);

    expect(screen.hasControl(INSTALL)).toBe(false);
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

function expectComeBackReason(read: ReturnType<typeof reading>, reason: string): void {
  expect.soft(read?.alert ?? '', 'the reason is in its error line').toContain(reason);
  expect.soft(read?.description ?? '', 'the reason is in the dialog description').toContain(reason);
}

function pressIfShown(screen: ReturnType<typeof setupCheckScreen>, name: string): boolean {
  if (!screen.isOpen() || !screen.hasControl(name)) return false;
  screen.control(name).click();
  return true;
}

describe('Install/update examples runs the install inside the popup (AC2, AC3, AC4, AC5, AC9, AC10, AC11)', () => {
  const MIXED = [ENTRY.notIgnored, ENTRY.examplesStale];

  function openMixed(fake: ReturnType<typeof fakeSetupDeps>, ...rereads: Array<SetupStatusReply | { reject: string }>) {
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, MIXED), ...rereads);
    return openPopup(fake);
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

  describe('a new attempt asks for a fresh preview and installs only what that preview offered', () => {
    it('after Back to the list', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(differingPreview('pv-first', ['flow']), cleanPreview('pv-second'));
      fake.examples.install(installSucceeded());
      const { screen } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      screen.control(INSTALL).click();
      await settle();
      expect.soft(pressIfShown(screen, BACK), 'the question offers Back to the list').toBe(true);
      await settle();

      expect.soft(pressIfShown(screen, INSTALL), 'the list offers Install/update examples again').toBe(true);
      await settle();

      expect.soft(fake.examples.previews(), 'a preview for each attempt').toBe(2);
      expect.soft(fake.examples.requests(), 'the install names the second preview').toEqual([
        { previewId: 'pv-second', replace: [], removeRetired: false },
      ]);
    });

    it('after a failed install', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-first'), cleanPreview('pv-second'));
      fake.examples.install(installFailed('scripted first install failure'), installSucceeded());
      const { screen } = await openMixed(fake, repoStatus(REPO.alpha, MIXED), repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      screen.control(INSTALL).click();
      await settle();

      expect.soft(pressIfShown(screen, INSTALL), 'the list offers Install/update examples again').toBe(true);
      await settle();

      expect.soft(fake.examples.previews(), 'a preview for each attempt').toBe(2);
      expect.soft(fake.examples.requests().map((request) => request.previewId), 'each install names its own preview').toEqual([
        'pv-first',
        'pv-second',
      ]);
    });
  });

  describe('while a preview request is pending', () => {
    it('Escape and the scrim leave the popup open, and the install still runs once the preview answers', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-held'));
      fake.examples.install(installSucceeded());
      const release = fake.examples.holdPreview();
      const { screen } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.notIgnored]));
      screen.control(INSTALL).click();
      await settle();
      expect.soft(fake.examples.previews(), 'the preview is pending').toBe(1);

      if (screen.isOpen()) screen.pressEscape();
      await settle();
      expect.soft(screen.isOpen(), 'Escape leaves it open').toBe(true);
      if (screen.isOpen()) screen.pressScrim();
      await settle();
      expect.soft(screen.isOpen(), 'the scrim leaves it open').toBe(true);

      release();
      await settle();
      expect.soft(fake.examples.requests(), 'the install ran').toEqual([{ previewId: 'pv-held', replace: [], removeRetired: false }]);
      expect.soft(screen.isOpen(), 'the popup lists the re-read').toBe(true);
    });
  });

  describe('Run setup loop follows the re-read (AC5)', () => {
    for (const fixable of [ENTRY.absent, ENTRY.notIgnored]) {
      it(`is offered when the re-read reports the setup flow installed and lists ${fixable.condition}/${fixable.failure}`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-run'));
        fake.examples.install(installSucceeded());
        fake.answer(REPO.alpha, repoStatus(REPO.alpha, [fixable, ENTRY.examplesStale], false), repoStatus(REPO.alpha, [fixable], true));
        const { screen } = await openPopup(fake);
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
      const { screen } = await openPopup(fake);

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
        expectComeBackReason(read, REASON);
      });

      it(`a failed install (${'reject' in reply ? 'rejected' : 'refused'}) whose re-read lists nothing keeps the popup open with the reason, and Close ends it`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-fail-empty'));
        fake.examples.install(reply);
        const { screen } = await openMixed(fake, repoStatus(REPO.alpha, []));

        screen.control(INSTALL).click();
        await settle();

        const read = reading(screen);
        expect.soft(read !== null, 'the popup is still open').toBe(true);
        expectComeBackReason(read, REASON);
        expect.soft(read?.controls, 'it offers Close').toContain('Close');
        if (screen.isOpen()) screen.control('Close').click();
        await settle();
        expect.soft(screen.isOpen(), 'Close ends it').toBe(false);
      });

      it(`a failed install (${'reject' in reply ? 'rejected' : 'refused'}) followed by a failed re-read shows the install reason and keeps the previous entries`, async () => {
        const fake = fakeSetupDeps();
        fake.examples.preview(cleanPreview('pv-fail-both'));
        fake.examples.install(reply);
        const { screen, before } = await openMixed(fake, { ok: false, reason: 'scripted-reread-reason-kx' });

        screen.control(INSTALL).click();
        await settle();

        const read = reading(screen);
        expect.soft(read?.entries, 'the previous entries').toEqual(before.entries);
        expectComeBackReason(read, REASON);
        expect.soft(read?.description, 'not the re-read reason').not.toContain('scripted-reread-reason-kx');
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
        expectComeBackReason(read, REASON);
      });
    }
  });

  describe('a dialog disposed while a request is pending draws nothing when it answers', () => {
    const drawn = (host: HTMLElement, screen: ReturnType<typeof setupCheckScreen>) => ({
      open: screen.isOpen(),
      focusInHost: host.contains(document.activeElement),
    });

    it('an install', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-dispose-install'));
      fake.examples.install(installSucceeded());
      const release = fake.examples.holdInstall();
      const { host, dialog, screen } = await openMixed(fake, repoStatus(REPO.alpha, [ENTRY.examplesStale]));
      screen.control(INSTALL).click();
      await settle();
      expect.soft(fake.examples.requests().length, 'the install is pending').toBe(1);

      dialog.dispose();
      release();
      await settle();

      expect(drawn(host, screen)).toEqual({ open: false, focusInHost: false });
    });

    it('a preview', async () => {
      const fake = fakeSetupDeps();
      fake.examples.preview(cleanPreview('pv-dispose-preview'));
      const release = fake.examples.holdPreview();
      const { host, dialog, screen } = await openMixed(fake);
      screen.control(INSTALL).click();
      await settle();
      expect.soft(fake.examples.previews(), 'the preview is pending').toBe(1);

      dialog.dispose();
      release();
      await settle();

      expect.soft(fake.examples.requests(), 'nothing installed').toEqual([]);
      expect(drawn(host, screen)).toEqual({ open: false, focusInHost: false });
    });
  });

});

describe('a popup raised outside a git repository', () => {
  it('names no directory in its title or description', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, plainStatus(REPO.alpha, [ENTRY.examplesStale]));
    const { dialog, buttonHost, screen } = mountDialog(fake);

    await dialog.check(REPO.alpha);
    pressSetupNeeded(buttonHost);

    expect(`${screen.title()} ${screen.description()}`).not.toContain(REPO.alpha);
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
    const { host, buttonHost, dialog, screen, raise } = mountDialog(fake);
    await raise(REPO.charlie);
    messages.push(...screen.entries());
    dialog.dispose();
    host.remove();
    buttonHost.remove();
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
      const { screen } = await openPopup(fake);

      expect(screen.hasControl(control)).toBe(true);
    });

    it(`hides ${control} when only entries it does not silence are listed`, async () => {
      const fake = fakeSetupDeps();
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, otherOnly));
      const { screen } = await openPopup(fake);

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
      const { screen } = await openPopup(fake);

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
      const { host, screen } = await openPopup(fake);
      const before = screen.entries();
      const writtenToAlerts = alertTextsWrittenIn(host);

      screen.control(FOR_REPO).click();

      await vi.waitFor(() =>
        expect({
          asked: fake.dismissals().length,
          entries: screen.entries(),
          retryable: screen.hasControl(FOR_REPO),
          alerted: (screen.alert() ?? '').includes(reason),
        }).toEqual({ asked: 1, entries: before, retryable: true, alerted: true }),
      );
      expect(writtenToAlerts().some((text) => text.includes(reason)), 'written to the alert after the card was in the page').toBe(true);
    });
  }
});

describe('the last dismissal closes the popup as an accept', () => {
  it('with focus back on the setup needed button while the re-read still lists something', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent]), repoStatus(REPO.alpha, [ENTRY.examplesStale]));
    const { screen, raise } = mountDialog(fake);
    const opener = await raise(REPO.alpha);

    screen.control(FOR_REPO).click();

    await vi.waitFor(() =>
      expect({ open: screen.isOpen(), focusOnOpener: document.activeElement === opener }).toEqual({
        open: false,
        focusOnOpener: true,
      }),
    );
  });

});

describe('a dismissal still being saved when the dialog is disposed', () => {
  it('draws nothing in the host once its save answers', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.examplesStale]));
    let answer: (reply: { ok: true }) => void = () => {};
    const saved = new Promise<{ ok: true }>((resolve) => (answer = resolve));
    fake.deps.dismiss = () => saved;
    const { host, dialog, screen } = await openPopup(fake);

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
      const { screen } = await openPopup(fake);

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

describe('pressing Run setup loop', () => {
  const FIXED_AND_EXAMPLES = [ENTRY.notIgnored, ENTRY.absent, ENTRY.examplesStale];

  it("closes the popup and starts the repo-setup flow in the popup's repository, not the one the terminal moved to", async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
    fake.answer(REPO.bravo, repoStatus(REPO.bravo, [ENTRY.malformed]));
    const release = fake.setupFlow.hold();
    const { dialog, screen } = await openPopup(fake);
    void dialog.check(REPO.bravo);
    await settle();

    screen.control(RUN_SETUP).click();
    await settle();
    const whileStarting = screen.isOpen();
    release();
    await settle();

    expect({ whileStarting, runs: fake.setupFlow.runs(), open: screen.isOpen() }).toEqual({
      whileStarting: false,
      runs: [REPO.alpha],
      open: false,
    });
  });

  it('once the flow starts, the button no longer counts the entries the setup flow fixes for that repository', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent], true), repoStatus(REPO.alpha, [ENTRY.notIgnored, ENTRY.absent], true));
    const { buttonHost, screen } = await openPopup(fake);

    screen.control(RUN_SETUP).click();
    await settle();

    expect({ runs: fake.setupFlow.runs(), button: setupNeededButton(buttonHost) }).toEqual({ runs: [REPO.alpha], button: null });
  });

  it('once the flow starts, the button still opens the popup for what the setup flow does not fix, without Run setup loop', async () => {
    const expected = await messagesOf([ENTRY.examplesStale]);
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true), repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
    const { buttonHost, screen } = await openPopup(fake);
    screen.control(RUN_SETUP).click();
    await settle();

    pressSetupNeeded(buttonHost);

    expect({ entries: screen.entries(), runSetup: screen.hasControl(RUN_SETUP) }).toEqual({ entries: expected, runSetup: false });
  });

  const FAILURES: Array<{ how: string; run: Parameters<ReturnType<typeof fakeSetupDeps>['setupFlow']['answer']>[0]; reason: string }> = [
    { how: 'is refused', run: { ok: false, reason: 'scripted begun-run refusal' }, reason: 'scripted begun-run refusal' },
    { how: 'is rejected', run: { reject: 'scripted start rejection' }, reason: 'scripted start rejection' },
  ];

  for (const { how, run, reason } of FAILURES) {
    it(`a start that ${how} reports its reason, opens no popup, and leaves the button opening every entry with Run setup loop`, async () => {
      const fake = fakeSetupDeps();
      fake.setupFlow.answer(run);
      fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true), repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
      const { buttonHost, screen, before } = await openPopup(fake);

      screen.control(RUN_SETUP).click();
      await settle();
      const failures = fake.setupFlow.failures();
      const openAfter = screen.isOpen();
      pressSetupNeeded(buttonHost);

      expect({
        reported: failures.length === 1 && failures[0].includes(reason),
        openAfter,
        entries: screen.entries(),
        runSetup: screen.hasControl(RUN_SETUP),
      }).toEqual({ reported: true, openAfter: false, entries: before.entries, runSetup: true });
    });
  }

  it('reports nothing when the start settles after the dialog was disposed', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.notIgnored], true));
    fake.setupFlow.answer({ ok: false, reason: 'scripted begun-run refusal' });
    const release = fake.setupFlow.hold();
    const { dialog, screen } = await openPopup(fake);
    screen.control(RUN_SETUP).click();
    await settle();

    dialog.dispose();
    release();
    await settle();

    expect(fake.setupFlow.failures()).toEqual([]);
  });
});
describe('Run setup loop over the real flow strip (AC18)', () => {
  it('opens the step-entry input modal with the popup closed, so it is the only modal open', async () => {
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
    fake.deps.runSetupFlow = createSetupFlowRun({ setActiveFlow: async () => ({ ok: true }), start: (repoKey) => strip.start(repoKey) });
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, [ENTRY.absent, ENTRY.examplesStale], true));
    const { screen } = await openPopup(fake);

    try {
      screen.control(RUN_SETUP).click();
      await settle();
      expect({
        modalsOpenWhenInputOpened,
        popupOpen: screen.isOpen(),
        focusInInputModal: inputHost.contains(document.activeElement),
      }).toEqual({ modalsOpenWhenInputOpened: [0], popupOpen: false, focusInInputModal: true });
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
      const { screen } = await openPopup(fake);

      screen.control(press).click();

      await vi.waitFor(() => expect({ dismissed: screen.hasControl(press), runSetup: screen.hasControl(RUN_SETUP) }).toEqual({ dismissed: false, runSetup: offered }));
    });
  }
});

describe('Run setup loop waits for an agent at the terminal prompt', () => {
  const FIXED_AND_EXAMPLES: SetupConditionEntry[] = [ENTRY.notIgnored, ENTRY.absent, ENTRY.examplesStale];

  function noAgentPopup(entries: SetupConditionEntry[] = FIXED_AND_EXAMPLES) {
    const fake = fakeSetupDeps();
    fake.agent.set('absent');
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, entries, true));
    return { fake, opened: openPopup(fake) };
  }

  it('with no agent running, offers the install and the dismissals but not Run setup loop', async () => {
    const { opened } = noAgentPopup();
    const { screen } = await opened;

    expect({ runSetup: screen.hasControl(RUN_SETUP), install: screen.hasControl(INSTALL), close: screen.hasControl('Close') }).toEqual({
      runSetup: false,
      install: true,
      close: true,
    });
  });

  it('says something different in its description when Run setup loop waits for an agent than when it is offered', async () => {
    const { opened } = noAgentPopup();
    const { screen } = await opened;
    const without = screen.description();
    const withAgent = fakeSetupDeps();
    withAgent.answer(REPO.bravo, repoStatus(REPO.bravo, FIXED_AND_EXAMPLES, true));
    const other = mountDialog(withAgent);
    await other.raise(REPO.bravo);

    expect(without.replace(REPO.alpha, '')).not.toEqual(other.screen.description().replace(REPO.bravo, ''));
  });

  it('offers Run setup loop in the open popup as soon as an agent starts, keeping its entries', async () => {
    const { fake, opened } = noAgentPopup();
    const { screen, before } = await opened;

    fake.agent.set('idle');

    await vi.waitFor(() => expect(screen.hasControl(RUN_SETUP)).toBe(true));
    expect(screen.entries()).toEqual(before.entries);
  });

  it('withdraws Run setup loop from the open popup when the agent leaves the prompt', async () => {
    const fake = fakeSetupDeps();
    fake.answer(REPO.alpha, repoStatus(REPO.alpha, FIXED_AND_EXAMPLES, true));
    const { screen } = await openPopup(fake);

    fake.agent.set('absent');

    await vi.waitFor(() => expect(screen.hasControl(RUN_SETUP)).toBe(false));
  });

  it('offers Run setup loop while the agent is busy', async () => {
    const { fake, opened } = noAgentPopup();
    const { screen } = await opened;

    fake.agent.set('busy');

    await vi.waitFor(() => expect(screen.hasControl(RUN_SETUP)).toBe(true));
  });

});
