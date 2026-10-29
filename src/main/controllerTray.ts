// untestable (native tray image, menu and clicks; no e2e observes the tray, operator decision) — tracked in #153.
import { Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { errMsg } from './errno';
import {
  controllerTrayIcon, controllerTrayMenu,
  type ControllerTrayActions, type ControllerTrayMenuMode, type ControllerTrayView, type TrayBadge,
} from './controllerTrayModel';
import type { AppIcon } from './appIcon';
import { CONTROLLER_APP_NAME } from './controllerAppName';

const ICON_PIXELS = 32;
const ICON_SCALE = 2;

export interface ControllerTray {
  show(view: ControllerTrayView): void;
  destroy(): void;
}

export function createControllerTray(iconPath: (icon: AppIcon) => string, mode: ControllerTrayMenuMode, actions: ControllerTrayActions): ControllerTray {
  try {
    return nativeTray(iconPath, mode, actions);
  } catch (error) {
    console.error(`Controller tray not created: ${errMsg(error)}`);
    return { show() {}, destroy() {} };
  }
}

function trayImage(path: string): NativeImage {
  const resized = nativeImage.createFromPath(path).resize({ width: ICON_PIXELS, height: ICON_PIXELS });
  return nativeImage.createFromBuffer(resized.toPNG(), { scaleFactor: ICON_SCALE });
}

function nativeTray(iconPath: (icon: AppIcon) => string, mode: ControllerTrayMenuMode, actions: ControllerTrayActions): ControllerTray {
  const image = (badge: TrayBadge) => trayImage(iconPath(controllerTrayIcon(badge)));
  const images: Record<TrayBadge, NativeImage> = { none: image('none'), 'needs-human': image('needs-human'), error: image('error') };
  const menu = (view: ControllerTrayView) => Menu.buildFromTemplate(controllerTrayMenu(view, actions));
  const tray = new Tray(images.none);
  tray.setToolTip(CONTROLLER_APP_NAME);
  let current: ControllerTrayView | undefined;
  tray.on('click', () => actions.open());
  if (mode === 'popup-on-right-click') tray.on('right-click', () => { if (current) tray.popUpContextMenu(menu(current)); });
  const show = (view: ControllerTrayView) => {
    if (tray.isDestroyed()) return;
    current = view;
    try {
      tray.setImage(images[view.badge]);
      if (mode === 'attached') tray.setContextMenu(menu(view));
    } catch (error) {
      console.error(`Controller tray not updated: ${errMsg(error)}`);
    }
  };
  return {
    show,
    destroy() {
      if (!tray.isDestroyed()) tray.destroy();
    },
  };
}
