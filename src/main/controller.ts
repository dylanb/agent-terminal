import { app, BrowserWindow } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startControllerTransport } from './controllerTransport';
import { resolveAppHome } from './launchRoot';
import { installNavigationGuards } from './windowGuards';
import { CONTROLLER_WINDOW_ARGUMENT } from '../shared/ipc';
import { installControllerIpc } from './controllerIpc';
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
    const disposeIpc = installControllerIpc(window.webContents, transport);
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
