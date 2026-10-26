import type { Theme } from '../shared/ipc';

export interface ControllerSettingsStore {
  theme(): Theme;
  saveTheme(theme: Theme): void;
}

export function createControllerSettingsStore(_userDataDir: string): ControllerSettingsStore {
  return { theme: () => undefined as never, saveTheme: () => {} };
}
