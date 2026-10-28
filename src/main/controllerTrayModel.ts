import type { MenuItemConstructorOptions } from 'electron';
import { cardCounts, statusSummary } from '../shared/controllerCardStatus';
import { directoryCards } from '../shared/controllerCards';
import type { ControllerTerminal } from '../shared/ipc';

export const CONTROLLER_APP_NAME = 'Agent Terminal Controller';

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

/** The light-theme `--status-needs-human` and `--status-error` of tokens.css, as [r, g, b]. */
export const TRAY_BADGE_COLOURS: Readonly<Record<Exclude<TrayBadge, 'none'>, readonly [number, number, number]>> = {
  'needs-human': [0xc9, 0x7f, 0x14],
  error: [0xe5, 0x48, 0x4d],
};

export function controllerTrayView(terminals: readonly ControllerTerminal[], alwaysOnTop: boolean): ControllerTrayView {
  const cards = directoryCards(terminals);
  const summary = statusSummary(cards);
  const count = (label: string) => summary.find(entry => entry.label === label)?.count ?? 0;
  const errors = count('errors');
  const needsHuman = count('need a human');
  const { connected, disconnected } = cardCounts(cards);
  const badge: TrayBadge = errors ? 'error' : needsHuman ? 'needs-human' : 'none';
  return { badge, connected, errors, disconnectedErrors: disconnected, needsHuman, alwaysOnTop };
}

export function watchTrayView(sources: ControllerTraySources, onView: (view: ControllerTrayView) => void): () => void {
  let terminals: ControllerTerminal[] = [];
  let shown = '';
  const show = (alwaysOnTop: boolean) => {
    const view = controllerTrayView(terminals, alwaysOnTop);
    if (JSON.stringify(view) === shown) return;
    shown = JSON.stringify(view);
    onView(view);
  };
  const stopTerminals = sources.subscribeTerminals(next => {
    terminals = next;
    show(sources.alwaysOnTop.current());
  });
  const stopAlwaysOnTop = sources.alwaysOnTop.subscribe(show);
  return () => {
    stopTerminals();
    stopAlwaysOnTop();
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function controllerTrayMenu(view: ControllerTrayView, actions: ControllerTrayActions): MenuItemConstructorOptions[] {
  const line = (label: string): MenuItemConstructorOptions => ({ label, enabled: false });
  const disconnectedShare = view.disconnectedErrors ? ` (${view.disconnectedErrors} disconnected)` : '';
  return [
    line(CONTROLLER_APP_NAME),
    line(`${view.connected} connected`),
    ...(view.errors ? [line(`${plural(view.errors, 'error', 'errors')}${disconnectedShare}`)] : []),
    ...(view.needsHuman ? [line(plural(view.needsHuman, 'needs a human', 'need a human'))] : []),
    { type: 'separator' },
    { label: 'Open Controller', click: () => actions.open() },
    { label: 'Always on top', type: 'checkbox', checked: view.alwaysOnTop, click: () => actions.setAlwaysOnTop(!view.alwaysOnTop) },
    { type: 'separator' },
    { label: 'Quit Controller', click: () => actions.quit() },
    line('Terminals keep working after you quit and reconnect when the controller returns.'),
  ];
}

export function controllerTrayMenuMode(platform: NodeJS.Platform): ControllerTrayMenuMode {
  return platform === 'darwin' ? 'popup-on-right-click' : 'attached';
}

export function paintTrayBadge(bitmap: TrayBitmap, badge: TrayBadge): TrayBitmap {
  const bgra = Uint8Array.from(bitmap.bgra);
  if (badge !== 'none') {
    const [r, g, b] = TRAY_BADGE_COLOURS[badge];
    const radius = Math.max(2, Math.round(Math.min(bitmap.width, bitmap.height) * 0.22));
    const centreX = bitmap.width - radius;
    const centreY = bitmap.height - radius;
    for (let y = 0; y < bitmap.height; y += 1) {
      for (let x = 0; x < bitmap.width; x += 1) {
        if ((x + 0.5 - centreX) ** 2 + (y + 0.5 - centreY) ** 2 <= radius ** 2) bgra.set([b, g, r, 255], (y * bitmap.width + x) * 4);
      }
    }
  }
  return { width: bitmap.width, height: bitmap.height, bgra };
}
