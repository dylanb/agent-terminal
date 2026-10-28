import { app, BrowserWindow, screen, type Rectangle } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from './controllerTransport';
import { resolveAppHome } from './launchRoot';
import { installNavigationGuards } from './windowGuards';
import { CONTROLLER_WINDOW_ARGUMENT } from '../shared/ipc';
import { installControllerIpc } from './controllerIpc';
import { createControllerSettingsStore } from './controllerSettings';
import { createControllerAlwaysOnTop } from './controllerAlwaysOnTop';
import { createControllerWindowStateStore, placeWindow } from './controllerWindowState';
import { errMsg } from './errno';
import { applyDockIcon, resolveWindowIconPath } from './appIcon';
import type { BundleLocation } from './bundleLocation';
import { controllerCloseAction } from './controllerWindowPolicy';
import { CONTROLLER_APP_NAME, controllerTrayMenuMode, watchTrayView, type ControllerTraySources } from './controllerTrayModel';
import { createControllerTray } from './controllerTray';

app.setName(CONTROLLER_APP_NAME);
let quitting = false;
app.on('before-quit', () => { quitting = true; });

void app.whenReady().then(async () => {
  const iconLoc: BundleLocation = app.isPackaged
    ? { packaged: true, resourcesPath: process.resourcesPath }
    : { packaged: false, appPath: app.getAppPath() };
  // untestable off macOS (no Linux e2e for the BrowserWindow.icon / dock assignment) — §12 gap tracked in #153.
  applyDockIcon(app.dock, process.platform, iconLoc, 'controller');
  const windowState = createControllerWindowStateStore(app.getPath('userData'));
  const saved = windowState.load();
  // untestable (bounds saved on a second attached display need a second screen) — tracked in #153.
  const bounds = placeWindow(saved.bounds, screen.getAllDisplays().map(display => display.workArea));
  const window = new BrowserWindow({
    ...bounds,
    icon: resolveWindowIconPath(iconLoc, 'controller'),
    alwaysOnTop: saved.alwaysOnTop,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), additionalArguments: [CONTROLLER_WINDOW_ARGUMENT], contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  installNavigationGuards(window.webContents);
  // Window managers that animate minimizing by sliding the frame (openbox) make Chromium report each step as a move,
  // so a minimized window's own bounds are not where the operator left it.
  let boundsBeforeMinimize: Rectangle | null = null;
  window.on('minimize', () => { boundsBeforeMinimize = window.getNormalBounds(); });
  window.on('restore', () => { boundsBeforeMinimize = null; });
  // untestable (macOS hide-on-close and Dock-click reopen are native) — tracked in #153.
  const closeAction = controllerCloseAction(process.platform);
  window.on('close', event => {
    if (quitting) {
      windowState.saveBounds(boundsBeforeMinimize ?? window.getNormalBounds());
      return;
    }
    event.preventDefault();
    // A full-screen window ignores minimize, and hiding one on macOS leaves its Space behind as a black screen.
    if (!window.isFullScreen()) {
      window[closeAction]();
      return;
    }
    window.once('leave-full-screen', () => window[closeAction]());
    window.setFullScreen(false);
  });
  const open = () => {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  app.on('activate', open);
  const alwaysOnTop = createControllerAlwaysOnTop({ window, store: windowState, initial: saved.alwaysOnTop });
  // untestable (the native tray; the operator's test scope leaves it to the manual checklist) — tracked in #153.
  const tray = createControllerTray(
    resolveWindowIconPath(iconLoc, 'controller'),
    controllerTrayMenuMode(process.platform),
    { open, setAlwaysOnTop: on => alwaysOnTop.set(on), quit: () => app.quit() },
  );
  const noTerminals: ControllerTraySources['subscribeTerminals'] = listener => {
    listener([]);
    return () => {};
  };
  let stopTray = watchTrayView({ subscribeTerminals: noTerminals, alwaysOnTop }, tray.show);
  app.once('will-quit', () => {
    stopTray();
    tray.destroy();
  });
  try {
    const transport = await startControllerTransport(resolveAppHome(process.env, homedir()));
    stopTray();
    stopTray = watchTrayView({ subscribeTerminals: transport.subscribeTerminals, alwaysOnTop }, tray.show);
    const disposeIpc = installControllerIpc(window.webContents, transport, createControllerSettingsStore(app.getPath('userData')), alwaysOnTop);
    window.once('closed', () => {
      disposeIpc();
      void transport.dispose().catch(error => console.error(errMsg(error)));
    });
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/controller.html`);
    else await window.loadFile(join(__dirname, '../renderer/controller.html'));
  } catch (error) {
    await window.loadURL(`data:text/plain,${encodeURIComponent(errMsg(error))}`);
  }
});

app.on('window-all-closed', () => app.quit());
