import type { Theme } from '../../shared/ipc';

const ONE_COLUMN_BELOW_PX = 640;

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

export interface ControllerClock {
  now(): number;
  onTick(listener: () => void): () => void;
}

export const TIME_IN_STATE_REFRESH_MS = 10_000;

export function createControllerClock(view: Window): ControllerClock {
  return {
    now: () => Date.now(),
    onTick(listener) {
      const interval = view.setInterval(listener, TIME_IN_STATE_REFRESH_MS);
      return () => view.clearInterval(interval);
    },
  };
}

export interface ControllerWindowFocus {
  focused(): boolean;
  onChange(listener: () => void): () => void;
}

export function createWindowFocus(view: Window): ControllerWindowFocus {
  return {
    focused: () => view.document.hasFocus(),
    onChange(listener) {
      view.addEventListener('focus', listener);
      view.addEventListener('blur', listener);
      return () => {
        view.removeEventListener('focus', listener);
        view.removeEventListener('blur', listener);
      };
    },
  };
}

export function applyDocumentTheme(root: HTMLElement, theme: Theme): void {
  root.dataset.theme = theme;
}
