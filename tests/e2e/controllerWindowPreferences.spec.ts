import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { heldHumanGate, seedTrustedFlow, type HeldHumanGate } from './autoGateHarness';
import { waitForConnections } from './controllerSnapshot';
import { STATUS_BUDGET_MS } from './controllerStatusObservation';
import {
  closeControllerWindow, isAlwaysOnTop, isFullScreen, isMaximized, isMinimized, minimizedOnDesktop, moveAndResize, normalBounds, shownOnDesktopAt,
  waitForAlwaysOnTop, type WindowBounds,
} from './controllerWindow';
import {
  alwaysOnTopLocator, cardHeaderLocator, cardLocator, listSequenceOf, sortOptionLocator, statusRowLocator, themeControlLocator, windowHeaderLocator,
} from '../helpers/controllerCards';
import { RECENTLY_USED_HEADING } from '../helpers/controllerCardOrderFixture';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { createControllerWindowStateStore } from '../../src/main/controllerWindowState';

const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };

interface Controller { app: ElectronApplication; page: Page }

async function toggleAlwaysOnTop(controller: Controller, on: boolean): Promise<void> {
  await alwaysOnTopLocator(controller.page).click();
  await waitForAlwaysOnTop(controller, on);
}

async function switchToDarkTheme({ page }: Controller): Promise<void> {
  await themeControlLocator(page, { on: false }).click();
  await expect.poll(() => page.evaluate(() => window.controller.getTheme())).toBe('dark');
}

test('a new profile starts with the controller always on top, shown on the header switch', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const { app, page } = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect.soft(alwaysOnTopLocator(page)).toHaveAttribute('aria-checked', 'true');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(true);
  } finally {
    await h.dispose();
  }
});

test('the header Always on top switch toggles by pointer, Space and Enter, and the window follows each toggle', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  try {
    const { app, page } = await h.launch(controllerTarget, h.fixture.nonGit);
    const control = alwaysOnTopLocator(page);
    /** Each toggle acts only on a switch the check before it has waited for, so a missing switch leaves every check to report. */
    const toggle = async (act: () => Promise<void>) => { if (await control.isVisible()) await act(); };
    const press = (key: string) => async () => { await control.focus(); await page.keyboard.press(key); };
    await expect.soft(control).toHaveAttribute('aria-checked', 'true');

    await toggle(() => control.click());
    await expect.soft(control).toHaveAttribute('aria-checked', 'false');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(false);

    await toggle(press('Space'));
    await expect.soft(control).toHaveAttribute('aria-checked', 'true');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(true);

    await toggle(press('Enter'));
    await expect.soft(control).toHaveAttribute('aria-checked', 'false');
    await expect.soft.poll(() => isAlwaysOnTop(app)).toBe(false);
  } finally {
    await h.dispose();
  }
});

type PreferenceStep = 'dark theme' | 'move and resize' | 'always on top off' | 'always on top on';
const ORDERS: ReadonlyArray<{ name: string; steps: readonly PreferenceStep[]; bounds: WindowBounds; endsOn: boolean; quitClosed: boolean }> = [
  {
    name: 'theme, bounds, then always-on-top off, quitting with the window open',
    steps: ['dark theme', 'move and resize', 'always on top off'], bounds: { x: 150, y: 120, width: 900, height: 640 }, endsOn: false, quitClosed: false,
  },
  {
    name: 'always-on-top off, theme, bounds, then always-on-top on, quitting with the window closed',
    steps: ['always on top off', 'dark theme', 'move and resize', 'always on top on'], bounds: { x: 60, y: 40, width: 1000, height: 700 }, endsOn: true, quitClosed: true,
  },
];

for (const order of ORDERS) {
  test(`the theme, size, position and always-on-top choice all survive Quit and relaunch: ${order.name}`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = await createControllerDesktopHarness();
    try {
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      let expected: WindowBounds | undefined;
      for (const step of order.steps) {
        if (step === 'dark theme') await switchToDarkTheme(controller);
        else if (step === 'move and resize') {
          expected = await moveAndResize(controller.app, h.fixture.env.DISPLAY, order.bounds);
        } else await toggleAlwaysOnTop(controller, step === 'always on top on');
      }
      if (order.quitClosed) await closeControllerWindow(controller.app);
      await controller.app.close();

      const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
      await expect.soft.poll(() => normalBounds(restarted.app)).toEqual(expected);
      await expect.soft(alwaysOnTopLocator(restarted.page)).toHaveAttribute('aria-checked', String(order.endsOn));
      await expect.soft.poll(() => isAlwaysOnTop(restarted.app)).toBe(order.endsOn);
      await expect.soft(themeControlLocator(restarted.page, { on: true })).toBeVisible();
    } finally {
      await h.dispose();
    }
  });
}

/** A flow no run has started, so a real terminal in its directory reads Unassigned (Idle & unassigned). */
const UNSTARTED_FLOW = 'name: sort-choice\nsteps:\n  - id: implement\n    kind: manual\n';

/** Moves the pointer to the window header and focus out of the cards, so no card is held when the order is read. */
async function away(page: Page): Promise<void> {
  await windowHeaderLocator(page).hover({ position: { x: 4, y: 4 } });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** Waits until the profile holds `sortMode`, so a Quit straight after a selection cannot drop its save; the checks after relaunch report a save that never lands. */
const sortModeSaved = (profile: string, sortMode: 'attention' | 'recently-used') =>
  expect.poll(() => createControllerSettingsStore(profile).sortMode()).toBe(sortMode).catch(() => undefined);

test('the selected card order survives Quit and relaunch with an empty recency list, beside the saved theme: Recently used, then Attention', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const [x, w] = h.fixture.repositories;
  try {
    for (const directory of [x, w]) seedTrustedFlow(h.fixture.home, directory, 'sort-choice', UNSTARTED_FLOW);
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const { page } = controller;
    await h.launch(terminalTarget, x);
    await expect(statusRowLocator(cardLocator(page, x))).toHaveText('Unassigned');
    await h.launch(terminalTarget, x);
    await expect(statusRowLocator(cardLocator(page, x))).toContainText('Duplicate directory');
    await h.launch(terminalTarget, w);
    await expect(statusRowLocator(cardLocator(page, w))).toHaveText('Unassigned');

    await switchToDarkTheme(controller);
    await sortOptionLocator(page, 'Recently used').click();
    await cardHeaderLocator(cardLocator(page, w), w).click();
    await away(page);
    await expect.poll(() => listSequenceOf(page, [x, w])).toEqual([RECENTLY_USED_HEADING, w, x]);
    await sortModeSaved(controller.profile, 'recently-used');
    await controller.app.close();

    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await waitForConnections(restarted.page, x, 2);
    await waitForConnections(restarted.page, w, 1);
    await expect(statusRowLocator(cardLocator(restarted.page, x))).toContainText('Duplicate directory');
    await expect(statusRowLocator(cardLocator(restarted.page, w))).toHaveText('Unassigned');
    await away(restarted.page);
    await expect.soft(sortOptionLocator(restarted.page, 'Recently used', { selected: true })).toBeVisible();
    await expect.soft.poll(() => listSequenceOf(restarted.page, [x, w])).toEqual([RECENTLY_USED_HEADING, x, w]);
    await expect.soft(themeControlLocator(restarted.page, { on: true })).toBeVisible();

    await sortOptionLocator(restarted.page, 'Attention').click();
    await sortModeSaved(controller.profile, 'attention');
    await restarted.app.close();
    const again = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.soft(sortOptionLocator(again.page, 'Attention', { selected: true })).toBeVisible();
    await expect.soft(themeControlLocator(again.page, { on: true })).toBeVisible();
  } finally {
    await h.dispose();
  }
});

for (const enlarged of ['maximized', 'full screen'] as const) {
  test(`a window ${enlarged} at Quit relaunches neither maximized nor full screen, at its bounds from before`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = await createControllerDesktopHarness();
    try {
      const controller = await h.launch(controllerTarget, h.fixture.nonGit);
      const before = await moveAndResize(controller.app, h.fixture.env.DISPLAY, { x: 90, y: 70, width: 960, height: 680 });
      if (enlarged === 'maximized') {
        await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
        await expect.poll(() => isMaximized(controller.app)).toBe(true);
      } else {
        await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setFullScreen(true));
        await expect.poll(() => isFullScreen(controller.app)).toBe(true);
      }
      await controller.app.close();

      const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
      await expect.soft.poll(() => normalBounds(restarted.app)).toEqual(before);
      await expect(alwaysOnTopLocator(restarted.page)).toBeVisible();
      const shownAtNormalBounds = await restarted.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return JSON.stringify(window.getBounds()) === JSON.stringify(window.getNormalBounds());
      });
      expect.soft({ maximized: await isMaximized(restarted.app), fullScreen: await isFullScreen(restarted.app), shownAtNormalBounds })
        .toEqual({ maximized: false, fullScreen: false, shownAtNormalBounds: true });
    } finally {
      await h.dispose();
    }
  });
}

test('tracer: a card collapsed before closing shows a gate reached while closed, stays collapsed, and the window comes back after relaunch', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  let gate: HeldHumanGate | undefined;
  try {
    gate = heldHumanGate(h.fixture, 'controller-window-preferences');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, gate.repo);
    await gate.start(terminal.page);
    const card = cardLocator(controller.page, gate.repo);
    const header = cardHeaderLocator(card, gate.repo);

    await toggleAlwaysOnTop(controller, false);
    const expected = await moveAndResize(controller.app, h.fixture.env.DISPLAY, { x: 110, y: 80, width: 920, height: 660 });
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await closeControllerWindow(controller.app);
    await gate.release();

    await expect.soft(card).toContainText('Needs a human', { timeout: STATUS_BUDGET_MS });
    expect.soft({ minimized: await isMinimized(controller.app), expanded: await header.getAttribute('aria-expanded') })
      .toEqual({ minimized: true, expanded: 'false' });
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await expect.poll(() => isMinimized(controller.app)).toBe(false);
    await shownOnDesktopAt(controller.app, h.fixture.env.DISPLAY, expected);
    await expect.soft(header).toHaveAttribute('aria-expanded', 'false');
    await expect.soft(card).toContainText('Needs a human');
    await controller.app.close();

    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.soft.poll(() => normalBounds(restarted.app)).toEqual(expected);
    await expect.soft(alwaysOnTopLocator(restarted.page)).toHaveAttribute('aria-checked', 'false');
    await expect.soft.poll(() => isAlwaysOnTop(restarted.app)).toBe(false);
  } finally {
    try { await h.dispose(); }
    finally { gate?.dispose(); }
  }
});

test('a window closed under a window manager that animates minimizing relaunches at its bounds from before closing', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  let gate: HeldHumanGate | undefined;
  try {
    gate = heldHumanGate(h.fixture, 'controller-window-animated-minimize');
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, gate.repo);
    await gate.start(terminal.page);
    const header = cardHeaderLocator(cardLocator(controller.page, gate.repo), gate.repo);
    const before = await moveAndResize(controller.app, h.fixture.env.DISPLAY, { x: 110, y: 80, width: 920, height: 660 });
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    await closeControllerWindow(controller.app);
    await minimizedOnDesktop(controller.app, h.fixture.env.DISPLAY);
    await gate.release();
    await controller.app.close();

    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.poll(() => normalBounds(restarted.app)).toEqual(before);
  } finally {
    try { await h.dispose(); }
    finally { gate?.dispose(); }
  }
});

test('a window saved where no attached display shows it relaunches at the default placement', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  try {
    const first = await h.launch(controllerTarget, h.fixture.nonGit);
    const defaultPlacement = await normalBounds(first.app);
    await first.app.close();
    createControllerWindowStateStore(first.profile).saveBounds({ x: 5000, y: 5000, width: 700, height: 500 });

    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: first.profile });
    await expect.poll(() => normalBounds(restarted.app)).toEqual(defaultPlacement);
  } finally {
    await h.dispose();
  }
});

test('a window moved after it is restored relaunches at where it was moved, not where it was before closing', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const before = await moveAndResize(controller.app, h.fixture.env.DISPLAY, { x: 110, y: 80, width: 920, height: 660 });
    await closeControllerWindow(controller.app);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await expect.poll(() => isMinimized(controller.app)).toBe(false);
    await shownOnDesktopAt(controller.app, h.fixture.env.DISPLAY, before);
    const moved = await moveAndResize(controller.app, h.fixture.env.DISPLAY, { x: 200, y: 150, width: 840, height: 600 });
    await controller.app.close();

    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.poll(() => normalBounds(restarted.app)).toEqual(moved);
  } finally {
    await h.dispose();
  }
});
