export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControllerWindowState {
  /** `null` opens the window at the default size and placement. */
  bounds: WindowBounds | null;
  alwaysOnTop: boolean;
}

export interface ControllerWindowStateStore {
  load(): ControllerWindowState;
  saveBounds(bounds: WindowBounds): void;
  saveAlwaysOnTop(alwaysOnTop: boolean): void;
}

export function createControllerWindowStateStore(_userDataDir: string): ControllerWindowStateStore {
  return {
    load: () => ({ bounds: null, alwaysOnTop: false }),
    saveBounds() {},
    saveAlwaysOnTop() {},
  };
}

export function placeWindow(_saved: WindowBounds | null, _workAreas: readonly WindowBounds[]): WindowBounds | null {
  return null;
}
