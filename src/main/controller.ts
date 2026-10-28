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

app.setName('Agent Terminal Controller');
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
  // untestable (the attached displays' work areas need a second screen) — tracked in #153.
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
  window.on('close', event => {
    if (quitting) {
      windowState.saveBounds(boundsBeforeMinimize ?? window.getNormalBounds());
      return;
    }
    event.preventDefault();
    window.minimize();
  });
  try {
    const transport = await startControllerTransport(resolveAppHome(process.env, homedir()));
    const disposeIpc = installControllerIpc(window.webContents, transport, createControllerSettingsStore(app.getPath('userData')), createControllerAlwaysOnTop({ window, store: windowState, initial: saved.alwaysOnTop }));
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
