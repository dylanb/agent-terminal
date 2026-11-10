import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';
import { createControllerWindowStateStore } from '../../src/main/controllerWindowState';

let userData: string;
beforeEach(() => { userData = mkdtempSync(join(tmpdir(), 'controller-settings-')); });
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(userData, { recursive: true, force: true });
});

const restarted = () => createControllerSettingsStore(userData).theme();

/** Rewrites every file a save left in `userData`; the file's name and shape are the store's own. */
function rewriteSaved(rewrite: (content: string) => string): void {
  for (const name of readdirSync(userData)) writeFileSync(join(userData, name), rewrite(readFileSync(join(userData, name), 'utf8')));
}

describe('the controller theme store', () => {
  it('reads light when nothing has been saved', () => {
    expect(restarted()).toBe('light');
  });

  it.each([
    ['is not JSON', () => 'not json {{{'],
    ['holds an unrecognised theme', (content: string) => content.replaceAll('dark', 'sepia')],
  ] as const)('reads light when the saved file %s, and the next save overwrites it', (_case, rewrite) => {
    createControllerSettingsStore(userData).saveTheme('dark');
    rewriteSaved(rewrite);
    const bad = restarted();
    createControllerSettingsStore(userData).saveTheme('dark');
    expect({ bad, overwritten: restarted() }).toEqual({ bad: 'light', overwritten: 'dark' });
  });

  it.skipIf(process.getuid?.() === 0)('reads light when the saved file cannot be read, and the next save overwrites it', () => {
    createControllerSettingsStore(userData).saveTheme('dark');
    for (const name of readdirSync(userData)) chmodSync(join(userData, name), 0o000);
    let unreadable: unknown;
    expect.soft(() => { unreadable = restarted(); }).not.toThrow();
    createControllerSettingsStore(userData).saveTheme('dark');
    expect({ unreadable, overwritten: restarted() }).toEqual({ unreadable: 'light', overwritten: 'dark' });
  });

  it('reads back each saved theme after a restart, the latest save winning', () => {
    const store = createControllerSettingsStore(userData);
    store.saveTheme('dark');
    const dark = restarted();
    store.saveTheme('light');
    expect({ dark, light: restarted() }).toEqual({ dark: 'dark', light: 'light' });
  });

  it('logs a save into a userData it cannot write, without throwing', () => {
    const obstacle = join(userData, 'not-a-directory');
    writeFileSync(obstacle, '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createControllerSettingsStore(join(obstacle, 'user-data'));
    expect.soft(() => store.saveTheme('dark')).not.toThrow();
    expect(logged).toHaveBeenCalled();
  });

  it('keeps its theme apart from agent-terminal\'s ui-settings.json in the same userData', () => {
    const uiSettings = join(userData, 'ui-settings.json');
    const agentTerminal = '{\n  "theme": "dark",\n  "splitRatio": 0.3\n}\n';
    writeFileSync(uiSettings, agentTerminal);
    const unsaved = restarted();
    const store = createControllerSettingsStore(userData);
    store.saveTheme('light');
    store.saveTheme('dark');
    expect.soft(unsaved).toBe('light');
    expect(readFileSync(uiSettings, 'utf8')).toBe(agentTerminal);
  });
});

describe('the controller theme store over a userData it refuses to write through', () => {
  it('logs a save into a userData that is a symlink, saves nothing, and does not throw', () => {
    const target = mkdtempSync(join(tmpdir(), 'controller-settings-target-'));
    try {
      const linked = join(userData, 'linked-user-data');
      symlinkSync(target, linked);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect.soft(() => createControllerSettingsStore(linked).saveTheme('dark')).not.toThrow();
      expect({ logged: logged.mock.calls.length > 0, written: readdirSync(target), theme: createControllerSettingsStore(linked).theme() })
        .toEqual({ logged: true, written: [], theme: 'light' });
    } finally { rmSync(target, { recursive: true, force: true }); }
  });
});

const restartedSort = () => createControllerSettingsStore(userData).sortMode();
/** Each file in `userData` and its bytes. */
const files = (): Record<string, string> =>
  Object.fromEntries(readdirSync(userData).map(name => [name, readFileSync(join(userData, name), 'utf8')]));
/** The files `act` adds to `userData`, with their bytes; their name and shape are the store's own. */
function filesAddedBy(act: () => void): Record<string, string> {
  const before = files();
  act();
  return Object.fromEntries(Object.entries(files()).filter(([name]) => !(name in before)));
}
/** Rewrites each of `added`'s files on disk. */
function rewriteAdded(added: Record<string, string>, rewrite: (content: string) => string): void {
  for (const [name, content] of Object.entries(added)) writeFileSync(join(userData, name), rewrite(content));
}
/** The current bytes of each of `named`'s files. */
const bytesOf = (named: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.keys(named).map(name => [name, files()[name]]));
const savedTheme = () => createControllerSettingsStore(userData).theme();
const savedWindow = () => createControllerWindowStateStore(userData).load();
const MOVED = { x: 123, y: 99, width: 777, height: 555 };
function saveThemeAndWindow(): void {
  createControllerSettingsStore(userData).saveTheme('dark');
  const window = createControllerWindowStateStore(userData);
  window.saveBounds(MOVED);
  window.saveAlwaysOnTop(false);
}

describe('the controller sort-choice store', () => {
  it('reads Attention for a new profile, and reads back a choice saved before its userData exists', () => {
    const unsaved = restartedSort();
    rmSync(userData, { recursive: true, force: true });
    createControllerSettingsStore(userData).saveSortMode('recently-used');
    expect({ unsaved, saved: restartedSort() }).toEqual({ unsaved: 'attention', saved: 'recently-used' });
  });

  it('reads back each saved choice after a restart, the latest save winning', () => {
    const store = createControllerSettingsStore(userData);
    store.saveSortMode('recently-used');
    const recent = restartedSort();
    store.saveSortMode('attention');
    expect({ recent, attention: restartedSort() }).toEqual({ recent: 'recently-used', attention: 'attention' });
  });

  it.each([
    ['is not JSON', () => 'not json {{{'],
    ['is JSON but not an object', () => 'null'],
    ['holds neither of the two orders', (content: string) => content.replaceAll('recently-used', 'by-name')],
  ] as const)('reads Attention when the saved file %s, and the next save overwrites it', (_case, rewrite) => {
    const added = filesAddedBy(() => createControllerSettingsStore(userData).saveSortMode('recently-used'));
    const saved = restartedSort();
    rewriteAdded(added, rewrite);
    const bad = restartedSort();
    createControllerSettingsStore(userData).saveSortMode('recently-used');
    expect({ saved, bad, overwritten: restartedSort() }).toEqual({ saved: 'recently-used', bad: 'attention', overwritten: 'recently-used' });
  });

  it.skipIf(process.getuid?.() === 0)('reads Attention when the saved file cannot be read, and the next save overwrites it', () => {
    const added = filesAddedBy(() => createControllerSettingsStore(userData).saveSortMode('recently-used'));
    const saved = restartedSort();
    for (const name of Object.keys(added)) chmodSync(join(userData, name), 0o000);
    let unreadable: unknown;
    expect.soft(() => { unreadable = restartedSort(); }).not.toThrow();
    for (const name of Object.keys(added)) chmodSync(join(userData, name), 0o600);
    createControllerSettingsStore(userData).saveSortMode('recently-used');
    expect({ saved, unreadable, overwritten: restartedSort() }).toEqual({ saved: 'recently-used', unreadable: 'attention', overwritten: 'recently-used' });
  });

  it('logs a save into a userData it cannot write, without throwing', () => {
    const obstacle = join(userData, 'not-a-directory');
    writeFileSync(obstacle, '');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createControllerSettingsStore(join(obstacle, 'user-data'));
    expect.soft(() => store.saveSortMode('recently-used')).not.toThrow();
    expect(logged).toHaveBeenCalled();
  });

  it('loads the saved theme and window placement unchanged beside a damaged sort choice', () => {
    saveThemeAndWindow();
    const added = filesAddedBy(() => createControllerSettingsStore(userData).saveSortMode('recently-used'));
    const saved = restartedSort();
    rewriteAdded(added, () => 'not json {{{');
    expect({ saved, sortMode: restartedSort(), theme: savedTheme(), window: savedWindow() })
      .toEqual({ saved: 'recently-used', sortMode: 'attention', theme: 'dark', window: { bounds: MOVED, alwaysOnTop: false } });
  });

  it('leaves the theme and window-placement files byte-for-byte unchanged when the sort choice is saved', () => {
    saveThemeAndWindow();
    const themeAndWindow = files();
    const store = createControllerSettingsStore(userData);
    store.saveSortMode('attention');
    store.saveSortMode('recently-used');
    expect({ themeAndWindow: bytesOf(themeAndWindow), sortMode: restartedSort(), theme: savedTheme(), window: savedWindow() })
      .toEqual({ themeAndWindow, sortMode: 'recently-used', theme: 'dark', window: { bounds: MOVED, alwaysOnTop: false } });
  });

  it('leaves the sort-choice file byte-for-byte unchanged when the theme and window placement are saved', () => {
    const sortFiles = filesAddedBy(() => createControllerSettingsStore(userData).saveSortMode('recently-used'));
    saveThemeAndWindow();
    createControllerSettingsStore(userData).saveTheme('light');
    expect({ sortFiles: bytesOf(sortFiles), sortMode: restartedSort(), theme: savedTheme() })
      .toEqual({ sortFiles, sortMode: 'recently-used', theme: 'light' });
  });

  it('keeps its sort choice apart from agent-terminal\'s ui-settings.json in the same userData', () => {
    const uiSettings = join(userData, 'ui-settings.json');
    const agentTerminal = '{\n  "theme": "dark",\n  "sortMode": "attention"\n}\n';
    writeFileSync(uiSettings, agentTerminal);
    createControllerSettingsStore(userData).saveSortMode('recently-used');
    expect({ sortMode: restartedSort(), uiSettings: readFileSync(uiSettings, 'utf8') })
      .toEqual({ sortMode: 'recently-used', uiSettings: agentTerminal });
  });
});
