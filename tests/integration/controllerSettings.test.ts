import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControllerSettingsStore } from '../../src/main/controllerSettings';

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
