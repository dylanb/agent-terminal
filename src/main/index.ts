import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import {
  CH,
  SESSION_ID,
  type AgentInjectMsg,
  type MonitorCaptureMsg,
  type PtyInputMsg,
  type PtyResizeMsg,
} from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createShadowModel } from './shadow';
import { spawnAgentShell } from './pty';

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ptyProcess = await spawnAgentShell();
  const store = createMonitorEventStore();

  const send = (channel: string, payload: unknown): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  const shadow = createShadowModel({
    onStatus: (status) => send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status }),
  });

  const inject = createInjector({
    write: (data) => ptyProcess.write(data),
    isBracketedPaste: () => shadow.isBracketedPaste(),
  });

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee.
  ptyProcess.onData((data) => {
    send(CH.ptyData, { sessionId: SESSION_ID, data });
    shadow.write(data);
  });
  ptyProcess.onExit(({ exitCode }) => send(CH.ptyExit, { sessionId: SESSION_ID, code: exitCode }));

  ipcMain.on(CH.ptyInput, (_e, m: PtyInputMsg) => ptyProcess.write(m.data));
  // PTY and shadow must never diverge in size, or captures mis-wrap (§4 flow F).
  ipcMain.on(CH.ptyResize, (_e, m: PtyResizeMsg) => {
    ptyProcess.resize(m.cols, m.rows);
    shadow.resize(m.cols, m.rows);
  });
  ipcMain.on(CH.monitorCapture, (_e, m: MonitorCaptureMsg) => {
    const event = store.addCapture(m);
    send(CH.monitorEvent, { sessionId: SESSION_ID, event });
  });
  ipcMain.handle(CH.monitorReplay, () => store.list());
  ipcMain.on(CH.agentInject, (_e, m: AgentInjectMsg) => inject(m.text, { submit: m.submit }));

  win.on('closed', () => {
    ipcMain.removeHandler(CH.monitorReplay);
    ptyProcess.kill();
    shadow.dispose();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
