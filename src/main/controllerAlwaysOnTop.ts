export interface ControllerAlwaysOnTop {
  current(): boolean;
  set(alwaysOnTop: boolean): void;
  subscribe(listener: (alwaysOnTop: boolean) => void): () => void;
}

export interface ControllerAlwaysOnTopDeps {
  window: { setAlwaysOnTop(alwaysOnTop: boolean): void };
  store: { saveAlwaysOnTop(alwaysOnTop: boolean): void };
  initial: boolean;
}

export function createControllerAlwaysOnTop(deps: ControllerAlwaysOnTopDeps): ControllerAlwaysOnTop {
  let current = deps.initial;
  return {
    current: () => current,
    set(alwaysOnTop) {
      deps.window.setAlwaysOnTop(alwaysOnTop);
      current = alwaysOnTop;
      deps.store.saveAlwaysOnTop(alwaysOnTop);
    },
    subscribe: () => () => {},
  };
}
