export interface ControllerAlwaysOnTop {
  current(): boolean;
  set(alwaysOnTop: boolean): void;
}

export interface ControllerAlwaysOnTopDeps {
  window: { setAlwaysOnTop(alwaysOnTop: boolean): void };
  initial: boolean;
}

export function createControllerAlwaysOnTop(_deps: ControllerAlwaysOnTopDeps): ControllerAlwaysOnTop {
  return { current: () => false, set() {} };
}
