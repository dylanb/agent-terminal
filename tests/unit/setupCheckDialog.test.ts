// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSetupCheckDialog, type SetupCheckDialog } from '../../src/renderer/src/setupCheckDialog';
import { ENTRY, REPO, fakeSetupDeps, repoStatus } from '../helpers/setupCheckFixtures';
import { recordSetupDialogs, setupCheckScreen } from '../helpers/setupCheckScreen';

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

  it('gives each failure kind its own message (AC1, AC2, AC3, AC6)', async () => {
    const kinds = [ENTRY.absent, ENTRY.malformed, ENTRY.confinement, ENTRY.notIgnored, ENTRY.unchecked];
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
