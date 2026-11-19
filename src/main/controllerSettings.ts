import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROLLER_DEFAULT_SORT_MODE, CONTROLLER_DEFAULT_THEME, isControllerSortMode, isTheme, type ControllerSortMode, type Theme } from '../shared/ipc';
import { atomicWriteFileSync } from './atomicFile';
import { errMsg } from './errno';
import { isRecord } from './yamlRecord';

export interface ControllerSettingsStore {
  theme(): Theme;
  saveTheme(theme: Theme): void;
  sortMode(): ControllerSortMode;
  saveSortMode(sortMode: ControllerSortMode): void;
}

function readSaved<T>(file: string, key: string, valid: (value: unknown) => value is T, fallback: T): T {
  try {
    const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return isRecord(saved) && valid(saved[key]) ? saved[key] : fallback;
  } catch {
    return fallback;
  }
}

function writeSaved(file: string, userDataDir: string, what: string, record: Record<string, string>): void {
  try {
    if (!atomicWriteFileSync(file, JSON.stringify(record))) console.error(`Controller ${what} not saved: ${userDataDir} is not a directory`);
  } catch (error) {
    console.error(`Controller ${what} not saved: ${errMsg(error)}`);
  }
}

export function createControllerSettingsStore(userDataDir: string): ControllerSettingsStore {
  const themeFile = join(userDataDir, 'controller-settings.json');
  const sortFile = join(userDataDir, 'controller-sort.json');
  return {
    theme: () => readSaved(themeFile, 'theme', isTheme, CONTROLLER_DEFAULT_THEME),
    saveTheme(theme) { writeSaved(themeFile, userDataDir, 'theme', { theme }); },
    sortMode: () => readSaved(sortFile, 'sortMode', isControllerSortMode, CONTROLLER_DEFAULT_SORT_MODE),
    saveSortMode(sortMode) { writeSaved(sortFile, userDataDir, 'sort mode', { sortMode }); },
  };
}
