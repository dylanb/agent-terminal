import type { Theme } from '../../shared/ipc';

export const ONE_COLUMN_BELOW_PX = 640;

export interface ControllerLayout {
  oneColumn(): boolean;
  onChange(listener: () => void): () => void;
}

export function createViewportLayout(view: Window): ControllerLayout {
  const query = view.matchMedia(`(width < ${ONE_COLUMN_BELOW_PX}px)`);
  return {
    oneColumn: () => query.matches,
    onChange(listener) {
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
  };
}

export function applyDocumentTheme(_root: HTMLElement, _theme: Theme): void {}
