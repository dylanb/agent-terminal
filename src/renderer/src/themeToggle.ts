import type { Theme } from '../../shared/ipc';

export interface ThemeToggleDeps {
  theme: Theme;
  onChange(theme: Theme): void;
}

export function createThemeToggle(_host: HTMLElement, _deps: ThemeToggleDeps): { dispose(): void } {
  return { dispose() {} };
}
