import type { Theme } from '../../shared/ipc';
import { onPress } from './pressable';

export interface ThemeToggleDeps {
  theme: Theme;
  onChange(theme: Theme): void;
}

export function createThemeToggle(host: HTMLElement, deps: ThemeToggleDeps): { dispose(): void } {
  let theme = deps.theme;
  const button = host.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'controller-theme-toggle';
  const show = () => { button.textContent = theme === 'dark' ? 'Light theme' : 'Dark theme'; };
  show();
  onPress(button, () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    show();
    deps.onChange(theme);
  });
  host.append(button);
  return { dispose() { button.remove(); } };
}
