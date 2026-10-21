import { app, BrowserWindow, ipcMain } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from './controllerTransport';
import { resolveAppHome } from './launchRoot';
import { installNavigationGuards } from './windowGuards';
import { CONTROLLER_CH, CONTROLLER_WINDOW_ARGUMENT, SESSION_ID, type ControllerActivation, type ControllerSnapshot } from '../shared/ipc';
import { errMsg } from './errno';

app.setName('Agent Terminal Controller');
let quitting = false;
app.on('before-quit', () => { quitting = true; });

void app.whenReady().then(async () => {
  const window = new BrowserWindow({
    webPreferences: { preload: join(__dirname, '../preload/index.js'), additionalArguments: [CONTROLLER_WINDOW_ARGUMENT], contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  installNavigationGuards(window.webContents);
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window.minimize();
  });
  try {
    const transport = await startControllerTransport(resolveAppHome(process.env, homedir()));
    const send = (terminals: ControllerSnapshot['terminals']) => {
      if (!window.isDestroyed()) window.webContents.send(CONTROLLER_CH.terminals, { sessionId: SESSION_ID, terminals } satisfies ControllerSnapshot);
    };
    const unsubscribe = transport.subscribeTerminals(send);
    const subscribe = (event: Electron.IpcMainEvent) => {
      if (event.sender === window.webContents) send(transport.terminals());
    };
    ipcMain.on(CONTROLLER_CH.subscribe, subscribe);
    ipcMain.handle(CONTROLLER_CH.activate, (event, payload: ControllerActivation) => {
      if (event.sender !== window.webContents || payload?.sessionId !== SESSION_ID || typeof payload.id !== 'string') return 'unavailable';
      return transport.activate(payload.id);
    });
    ipcMain.handle(CONTROLLER_CH.dismiss, (event, payload: ControllerActivation) => {
      if (event.sender !== window.webContents || payload?.sessionId !== SESSION_ID || typeof payload.id !== 'string') return;
      transport.dismiss(payload.id);
    });
    window.once('closed', () => {
      unsubscribe();
      ipcMain.removeListener(CONTROLLER_CH.subscribe, subscribe);
      ipcMain.removeHandler(CONTROLLER_CH.activate);
      ipcMain.removeHandler(CONTROLLER_CH.dismiss);
      void transport.dispose().catch(error => console.error(errMsg(error)));
    });
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/controller.html`);
    else await window.loadFile(join(__dirname, '../renderer/controller.html'));
  } catch (error) {
    await window.loadURL(`data:text/plain,${encodeURIComponent(errMsg(error))}`);
  }
});

app.on('window-all-closed', () => app.quit());
