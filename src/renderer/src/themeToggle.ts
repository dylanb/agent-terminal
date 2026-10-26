import type { Theme } from '../../shared/ipc';

export interface ThemeToggleDeps {
  theme: Theme;
  onChange(theme: Theme): void;
}

export function createThemeToggle(host: HTMLElement, deps: ThemeToggleDeps): { dispose(): void } {
  let theme = deps.theme;
  const button = host.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'controller-theme-toggle';
  button.textContent = 'Dark theme';
  const show = () => button.setAttribute('aria-pressed', String(theme === 'dark'));
  show();
  button.addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    show();
    deps.onChange(theme);
  });
  host.append(button);
  return { dispose() { button.remove(); } };
}
