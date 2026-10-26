import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROLLER_DEFAULT_THEME, isTheme, type Theme } from '../shared/ipc';
import { atomicWriteFileSync } from './atomicFile';
import { errMsg } from './errno';
import { isRecord } from './yamlRecord';

export interface ControllerSettingsStore {
  theme(): Theme;
  saveTheme(theme: Theme): void;
}

export function createControllerSettingsStore(userDataDir: string): ControllerSettingsStore {
  const file = join(userDataDir, 'controller-settings.json');
  return {
    theme() {
      try {
        const saved: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return isRecord(saved) && isTheme(saved.theme) ? saved.theme : CONTROLLER_DEFAULT_THEME;
      } catch {
        return CONTROLLER_DEFAULT_THEME;
      }
    },
    saveTheme(theme) {
      try {
        if (!atomicWriteFileSync(file, JSON.stringify({ theme }))) console.error(`Controller theme not saved: ${userDataDir} is not a directory`);
      } catch (error) {
        console.error(`Controller theme not saved: ${errMsg(error)}`);
      }
    },
  };
}
