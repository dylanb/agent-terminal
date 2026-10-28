// untestable (native tray image, menu and clicks; no e2e observes the tray, operator decision) — tracked in #153.
import { Menu, nativeImage, Tray } from 'electron';
import { errMsg } from './errno';
import {
  CONTROLLER_APP_NAME, controllerTrayMenu, paintTrayBadge,
  type ControllerTrayActions, type ControllerTrayMenuMode, type ControllerTrayView, type TrayBitmap,
} from './controllerTrayModel';

const ICON_PIXELS = 32;
const ICON_SCALE = 2;

export interface ControllerTray {
  show(view: ControllerTrayView): void;
  destroy(): void;
}

export function createControllerTray(iconPath: string, mode: ControllerTrayMenuMode, actions: ControllerTrayActions): ControllerTray {
  try {
    return nativeTray(iconPath, mode, actions);
  } catch (error) {
    console.error(`Controller tray not created: ${errMsg(error)}`);
    return { show() {}, destroy() {} };
  }
}

function nativeTray(iconPath: string, mode: ControllerTrayMenuMode, actions: ControllerTrayActions): ControllerTray {
  const icon = nativeImage.createFromPath(iconPath).resize({ width: ICON_PIXELS, height: ICON_PIXELS });
  const base: TrayBitmap = { width: ICON_PIXELS, height: ICON_PIXELS, bgra: icon.toBitmap() };
  const paintable = base.bgra.length === ICON_PIXELS * ICON_PIXELS * 4;
  const image = (view: ControllerTrayView) => {
    if (!paintable) return icon;
    const painted = paintTrayBadge(base, view.badge);
    return nativeImage.createFromBitmap(Buffer.from(painted.bgra), { width: painted.width, height: painted.height, scaleFactor: ICON_SCALE });
  };
  const menu = (view: ControllerTrayView) => Menu.buildFromTemplate(controllerTrayMenu(view, actions));
  const tray = new Tray(icon);
  tray.setToolTip(CONTROLLER_APP_NAME);
  let current: ControllerTrayView | undefined;
  tray.on('click', () => actions.open());
  if (mode === 'popup-on-right-click') tray.on('right-click', () => { if (current) tray.popUpContextMenu(menu(current)); });
  const show = (view: ControllerTrayView) => {
    if (tray.isDestroyed()) return;
    current = view;
    try {
      tray.setImage(image(view));
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
