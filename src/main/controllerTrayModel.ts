import type { MenuItemConstructorOptions } from 'electron';
import { cardCounts, statusSummary, type CardStatusClass } from '../shared/controllerCardStatus';
import { directoryCards } from '../shared/controllerCards';
import type { ControllerTerminal } from '../shared/ipc';
import type { AppIcon } from './appIcon';
import { CONTROLLER_APP_NAME } from './controllerAppName';

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

export function controllerTrayView(terminals: readonly ControllerTerminal[], alwaysOnTop: boolean): ControllerTrayView {
  const cards = directoryCards(terminals);
  const summary = statusSummary(cards);
  const count = (statusClass: CardStatusClass) => summary.find(entry => entry.statusClass === statusClass)?.count ?? 0;
  const errors = count('error');
  const needsHuman = count('needs-human');
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

const TRAY_ICONS: Readonly<Record<TrayBadge, AppIcon>> = {
  none: 'controller',
  'needs-human': 'controller-needs-human',
  error: 'controller-error',
};

export function controllerTrayIcon(badge: TrayBadge): AppIcon {
  return TRAY_ICONS[badge];
}
