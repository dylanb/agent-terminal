import type { MenuItemConstructorOptions } from 'electron';
import type { ControllerTerminal } from '../shared/ipc';

export type TrayBadge = 'none' | 'needs-human' | 'error';

export interface ControllerTrayView {
  badge: TrayBadge;
  connected: number;
  errors: number;
  disconnectedErrors: number;
  needsHuman: number;
  alwaysOnTop: boolean;
}

export interface ControllerTrayActions {
  open(): void;
  setAlwaysOnTop(alwaysOnTop: boolean): void;
  quit(): void;
}

export interface ControllerTraySources {
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  alwaysOnTop: { current(): boolean; subscribe(listener: (alwaysOnTop: boolean) => void): () => void };
}

export type ControllerTrayMenuMode = 'attached' | 'popup-on-right-click';

/** An image as rows of 4-byte BGRA pixels, the layout of Electron's `NativeImage.toBitmap()`. */
export interface TrayBitmap {
  width: number;
  height: number;
  bgra: Uint8Array;
}

export function controllerTrayView(_terminals: readonly ControllerTerminal[], _alwaysOnTop: boolean): ControllerTrayView {
  return { badge: 'none', connected: 0, errors: 0, disconnectedErrors: 0, needsHuman: 0, alwaysOnTop: false };
}

export function watchTrayView(sources: ControllerTraySources, onView: (view: ControllerTrayView) => void): () => void {
  sources.subscribeTerminals(terminals => onView(controllerTrayView(terminals, sources.alwaysOnTop.current())));
  sources.alwaysOnTop.subscribe(alwaysOnTop => onView(controllerTrayView([], alwaysOnTop)));
  return () => {};
}

export function controllerTrayMenu(_view: ControllerTrayView, _actions: ControllerTrayActions): MenuItemConstructorOptions[] {
  return [];
}

export function controllerTrayMenuMode(_platform: NodeJS.Platform): ControllerTrayMenuMode {
  return 'attached';
}

export function paintTrayBadge(bitmap: TrayBitmap, _badge: TrayBadge): TrayBitmap {
  return { ...bitmap, bgra: Uint8Array.from(bitmap.bgra) };
}
