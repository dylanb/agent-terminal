import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { createControllerWindowStateStore, placeWindow, type WindowBounds } from '../../src/main/controllerWindowState';
import { CONTROLLER_DEFAULT_ALWAYS_ON_TOP } from '../../src/shared/ipc';

let userData: string;
beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'controller-window-state-')); });
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userData, { recursive: true, force: true });
});

const MOVED: WindowBounds = { x: 123, y: 99, width: 777, height: 555 };
const MOVED_AGAIN: WindowBounds = { x: -640, y: -47, width: 1011, height: 613 };
const DEFAULTS = { bounds: null, alwaysOnTop: CONTROLLER_DEFAULT_ALWAYS_ON_TOP };
const store = () => createControllerWindowStateStore(userData);
const restarted = () => store().load();

/** Each file in `userData` and its bytes. */
const files = (): Record<string, string> =>
  Object.fromEntries(readdirSync(userData).map(name => [name, readFileSync(join(userData, name), 'utf8')]));
/** Rewrites every file a save left in `userData`; the file's name and layout are the store's own. */
function rewriteSaved(rewrite: (content: string) => string): void {
  for (const name of readdirSync(userData)) writeFileSync(join(userData, name), rewrite(readFileSync(join(userData, name), 'utf8')));
}
function saveBoth(bounds: WindowBounds, alwaysOnTop: boolean): void {
  const saved = store();
  saved.saveBounds(bounds);
  saved.saveAlwaysOnTop(alwaysOnTop);
}

describe('the controller window-state store', () => {
  it('reads the defaults when nothing has been saved', () => {
    expect(restarted()).toEqual(DEFAULTS);
  });

  it('reads back each saved always-on-top choice after a restart, the latest save winning', () => {
    store().saveAlwaysOnTop(false);
    const off = restarted().alwaysOnTop;
    store().saveAlwaysOnTop(true);
    expect({ off, on: restarted().alwaysOnTop }).toEqual({ off: false, on: true });
  });

  it('reads back the saved bounds after a restart, the latest save winning', () => {
    store().saveBounds(MOVED);
    const first = restarted().bounds;
    store().saveBounds(MOVED_AGAIN);
    expect({ first, latest: restarted().bounds }).toEqual({ first: MOVED, latest: MOVED_AGAIN });
  });

  it('saves into a userData that does not exist yet', () => {
    rmSync(userData, { recursive: true, force: true });
    saveBoth(MOVED, false);
    expect(restarted()).toEqual({ bounds: MOVED, alwaysOnTop: false });
  });

  it('keeps the saved always-on-top choice when the bounds are saved, and the bounds when the choice is saved', () => {
    store().saveAlwaysOnTop(false);
    store().saveBounds(MOVED);
    const boundsAfterChoice = restarted();
    const same = store();
    same.saveBounds(MOVED_AGAIN);
    same.saveAlwaysOnTop(true);
    const choiceAfterBounds = restarted();
    same.saveBounds(MOVED);
    expect({ boundsAfterChoice, choiceAfterBounds, boundsAfterChoiceOnOneStore: restarted() }).toEqual({
      boundsAfterChoice: { bounds: MOVED, alwaysOnTop: false },
      choiceAfterBounds: { bounds: MOVED_AGAIN, alwaysOnTop: true },
      boundsAfterChoiceOnOneStore: { bounds: MOVED, alwaysOnTop: true },
    });
  });

  it.each([
    ['is not JSON', (): string => 'not json {{{'],
    ['is JSON but not an object', (): string => '[1, 2, 3]'],
  ] as const)('reads the defaults when the saved file %s, and the next save overwrites it', (_case, rewrite) => {
    saveBoth(MOVED, false);
    rewriteSaved(rewrite);
    const damaged = restarted();
    saveBoth(MOVED_AGAIN, false);
    expect({ damaged, overwritten: restarted() }).toEqual({ damaged: DEFAULTS, overwritten: { bounds: MOVED_AGAIN, alwaysOnTop: false } });
  });

  it.skipIf(process.getuid?.() === 0)('reads the defaults when the saved file cannot be read, and the next save overwrites it', () => {
    saveBoth(MOVED, false);
    for (const name of readdirSync(userData)) chmodSync(join(userData, name), 0o000);
    let unreadable: unknown;
    expect.soft(() => { unreadable = restarted(); }).not.toThrow();
    saveBoth(MOVED_AGAIN, false);
    expect({ unreadable, overwritten: restarted() }).toEqual({ unreadable: DEFAULTS, overwritten: { bounds: MOVED_AGAIN, alwaysOnTop: false } });
  });

  it.each([
    ['a size that is not positive', (content: string) => content.replace('777', '-777')],
    ['a zero size', (content: string) => content.replace('555', '0')],
    ['a position that is not a number', (content: string) => content.replace('123', '"123"')],
    ['a missing size', (content: string) => content.replace(/"[^"]+"\s*:\s*555\s*,/, '').replace(/,\s*"[^"]+"\s*:\s*555/, '')],
  ] as const)('defaults only the bounds when they hold %s, keeping the always-on-top choice, and the next save overwrites them', (_case, rewrite) => {
    saveBoth(MOVED, false);
    rewriteSaved(rewrite);
    const damaged = restarted();
    store().saveBounds(MOVED_AGAIN);
    expect({ damaged, overwritten: restarted() }).toEqual({
      damaged: { bounds: null, alwaysOnTop: false },
      overwritten: { bounds: MOVED_AGAIN, alwaysOnTop: false },
    });
  });

  it('defaults only the always-on-top choice when it is not a boolean, keeping the bounds, and the next save overwrites it', () => {
    saveBoth(MOVED, false);
    rewriteSaved(content => content.replace('false', '"no"'));
    const damaged = restarted();
    store().saveAlwaysOnTop(false);
    expect({ damaged, overwritten: restarted() }).toEqual({
      damaged: { bounds: MOVED, alwaysOnTop: CONTROLLER_DEFAULT_ALWAYS_ON_TOP },
      overwritten: { bounds: MOVED, alwaysOnTop: false },
    });
  });

  it('logs a save into a userData it cannot write, without throwing', () => {
    const obstacle = join(userData, 'not-a-directory');
    writeFileSync(obstacle, '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unwritable = createControllerWindowStateStore(join(obstacle, 'user-data'));
    expect.soft(() => unwritable.saveBounds(MOVED)).not.toThrow();
    const boundsLogged = logged.mock.calls.length > 0;
    logged.mockClear();
    expect.soft(() => unwritable.saveAlwaysOnTop(false)).not.toThrow();
    expect({ boundsLogged, alwaysOnTopLogged: logged.mock.calls.length > 0 }).toEqual({ boundsLogged: true, alwaysOnTopLogged: true });
  });
});

describe('the window-state store beside the theme store in the same userData', () => {
  it('starts an upgrading profile that holds only a saved theme with always-on-top on and its theme kept', () => {
    createControllerSettingsStore(userData).saveTheme('dark');
    expect({ window: restarted(), theme: createControllerSettingsStore(userData).theme() })
      .toEqual({ window: DEFAULTS, theme: 'dark' });
  });

  it('leaves the theme file byte-for-byte unchanged when it saves, and keeps its own record when the theme is saved', () => {
    createControllerSettingsStore(userData).saveTheme('dark');
    const themeOnly = files();
    saveBoth(MOVED, false);
    const themeAfterWindowSave = Object.fromEntries(Object.keys(themeOnly).map(name => [name, files()[name]]));
    const windowFiles = Object.fromEntries(Object.entries(files()).filter(([name]) => !(name in themeOnly)));
    createControllerSettingsStore(userData).saveTheme('light');
    const windowAfterThemeSave = Object.fromEntries(Object.keys(windowFiles).map(name => [name, files()[name]]));
    expect({
      themeAfterWindowSave, windowAfterThemeSave, window: restarted(), theme: createControllerSettingsStore(userData).theme(),
    }).toEqual({
      themeAfterWindowSave: themeOnly, windowAfterThemeSave: windowFiles, window: { bounds: MOVED, alwaysOnTop: false }, theme: 'light',
    });
  });
});

describe('placing the window over the work areas of the attached displays', () => {
  const PRIMARY: WindowBounds = { x: 0, y: 0, width: 1280, height: 1000 };
  const SECOND: WindowBounds = { x: 1280, y: 0, width: 1920, height: 1080 };
  const at = (x: number, y: number): WindowBounds => ({ x, y, width: 800, height: 600 });
  const cases: Record<string, [WindowBounds | null, readonly WindowBounds[]]> = {
    'inside the only work area': [at(100, 100), [PRIMARY]],
    'partly inside, its top-left corner off every display': [at(-700, -500), [PRIMARY]],
    'overlapping a work area by one pixel': [at(-799, 100), [PRIMARY]],
    'on the second display only': [at(2000, 300), [PRIMARY, SECOND]],
    'across both displays': [at(1000, 300), [PRIMARY, SECOND]],
    'on a display that is no longer attached': [at(2000, 300), [PRIMARY]],
    'touching a work area edge with no overlap': [at(-800, 100), [PRIMARY]],
    'level with a work area but entirely below it': [at(100, 1000), [PRIMARY]],
    'beside a work area but entirely to its right': [at(1280, 100), [PRIMARY]],
    'with no saved bounds': [null, [PRIMARY]],
    'with no display attached': [at(100, 100), []],
  };
  it('restores the saved bounds when any part lies within an attached work area, and the default placement otherwise', () => {
    expect(Object.fromEntries(Object.entries(cases).map(([name, [saved, areas]]) => [name, placeWindow(saved, areas)]))).toEqual({
      'inside the only work area': at(100, 100),
      'partly inside, its top-left corner off every display': at(-700, -500),
      'overlapping a work area by one pixel': at(-799, 100),
      'on the second display only': at(2000, 300),
      'across both displays': at(1000, 300),
      'on a display that is no longer attached': null,
      'touching a work area edge with no overlap': null,
      'level with a work area but entirely below it': null,
      'beside a work area but entirely to its right': null,
      'with no saved bounds': null,
      'with no display attached': null,
    });
  });
});
