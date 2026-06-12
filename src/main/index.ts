import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { CH, SESSION_ID, type ChannelPayloads, type SendChannel } from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createShadowModel } from './shadow';
import { spawnAgentShell } from './pty';
import { createOutputGate } from './outputGate';
import { resolveRendererTarget } from './rendererTarget';
import { denyWindowOpen, preventForeignNavigation } from './windowGuards';
import { isValidCapture, isValidInject, isValidInput, isValidResize } from './ipcValidation';
import { registerIpcListeners } from './sessionIpc';

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

  // The preload bridge exposes PTY-writing APIs; the window must never navigate
  // away from the bundled renderer or open child windows (§6, security checklist).
  win.webContents.setWindowOpenHandler(denyWindowOpen);
  win.webContents.on('will-navigate', preventForeignNavigation);

  const ptyProcess = await spawnAgentShell();
  const store = createMonitorEventStore();

  const send = <C extends SendChannel>(channel: C, payload: ChannelPayloads[C]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Hold early PTY output until the renderer has registered its pty:data listener (§8.1).
  const outputGate = createOutputGate((data) => send(CH.ptyData, { sessionId: SESSION_ID, data }));

  const shadow = createShadowModel({
    onStatus: (status) => send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status }),
  });

  const inject = createInjector({
    write: (data) => ptyProcess.write(data),
    isBracketedPaste: () => shadow.isBracketedPaste(),
  });

  // Flow A (§4): every output byte goes to the renderer AND the shadow tee.
  ptyProcess.onData((data) => {
    outputGate.send(data);
    shadow.write(data);
  });
  ptyProcess.onExit(({ exitCode }) => send(CH.ptyExit, { sessionId: SESSION_ID, code: exitCode }));

  const disposeIpc = registerIpcListeners(
    ipcMain,
    {
      [CH.ptyInput]: (_e, m) => {
        if (isValidInput(m)) ptyProcess.write(m.data);
      },
      // PTY and shadow must never diverge in size, or captures mis-wrap (§4 flow F).
      [CH.ptyResize]: (_e, m) => {
        if (isValidResize(m)) {
          ptyProcess.resize(m.cols, m.rows);
          shadow.resize(m.cols, m.rows);
        }
      },
      [CH.monitorCapture]: (_e, m) => {
        if (isValidCapture(m)) send(CH.monitorEvent, { sessionId: SESSION_ID, event: store.addCapture(m) });
      },
      [CH.agentInject]: (_e, m) => {
        if (isValidInject(m)) inject(m.text, { submit: m.submit });
      },
    },
    { [CH.monitorReplay]: () => store.list() },
  );

  win.on('closed', () => {
    disposeIpc();
    ptyProcess.kill();
    shadow.dispose();
  });

  const target = resolveRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
  });
  if (target.kind === 'url') await win.loadURL(target.url);
  else await win.loadFile(path.join(__dirname, '../renderer/index.html'));

  outputGate.open();
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});
