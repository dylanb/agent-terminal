import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { CH, SESSION_ID, type ChannelPayloads, type CommandSummary, type SendChannel } from '../shared/ipc';
import { createInjector } from './inject';
import { createMonitorEventStore } from './eventStore';
import { createShadowModel } from './shadow';
import { spawnAgentShell } from './pty';
import { createOutputGate } from './outputGate';
import { resolveRendererTarget } from './rendererTarget';
import { installNavigationGuards } from './windowGuards';
import {
  isValidCapture,
  isValidCaptureCommand,
  isValidCommandsRequest,
  isValidDismiss,
  isValidDismissAll,
  isValidInject,
  isValidInput,
  isValidResize,
} from './ipcValidation';
import { registerIpcListeners } from './sessionIpc';
import { resolveRuntimeConfig } from './runtimeConfig';
import { createCommandTracker } from './commandTracker';
import { createScanner } from './scanner';
import { createClaudeCodeAdapter } from './adapters/claudeCode';
import { createGenericAdapter } from './adapters/generic';
import { SHELL_INTEGRATION_SCRIPT } from './shellIntegration';

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
  installNavigationGuards(win.webContents);

  const config = resolveRuntimeConfig(process.env);
  const ptyProcess = await spawnAgentShell({
    integrationScriptPath: config.shellIntegration ? SHELL_INTEGRATION_SCRIPT : undefined,
  });
  const store = createMonitorEventStore();

  const send = <C extends SendChannel>(channel: C, payload: ChannelPayloads[C]): void => {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Hold early PTY output until the renderer has registered its pty:data listener (§8.1).
  const outputGate = createOutputGate((data) => send(CH.ptyData, { sessionId: SESSION_ID, data }));

  const shadow = createShadowModel({
    quietMs: config.quietMs,
    onStatus: (status) => send(CH.monitorUpdate, { sessionId: SESSION_ID, ...status }),
  });

  // Command-output capture (§15.5) and the agent-semantic scanner (§15.2/§15.3),
  // both reading only the shadow's public read path — detection only, no autonomy.
  const tracker = createCommandTracker({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    onOsc: (id, cb) => shadow.onOsc(id, cb),
    config,
  });
  // Command history is live off the OSC-133 marks, not §8.3 quiescence (§15.5).
  tracker.onChange(() => send(CH.monitorCommandsChanged, { sessionId: SESSION_ID }));
  const scanner = createScanner({
    reader: shadow.reader,
    addMarker: (r) => shadow.addMarker(r),
    onQuiet: (cb) => shadow.onQuiet(cb),
    adapters: config.adapterEnabled('claude-code') ? [createClaudeCodeAdapter()] : [],
    fallback: createGenericAdapter(),
    dedupRetention: config.dedupRetention,
    reportMinChars: config.reportMinChars,
    closedSpans: () => tracker.closedSpans(),
    emit: (e) => {
      const event = store.addEvent({
        sessionId: SESSION_ID,
        type: e.type,
        source: e.source,
        text: e.text,
        range: null,
        parentId: e.parentId,
        truncated: e.truncated,
      });
      send(CH.monitorEvent, { sessionId: SESSION_ID, event });
      return event.id;
    },
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
      // Fail-closed: an unknown/stale/trimmed commandId materializes nothing (§15.4).
      [CH.monitorCaptureCommand]: (_e, m) => {
        if (!isValidCaptureCommand(m)) return;
        const cap = tracker.capture(m.commandId);
        if (!cap) return;
        const event = store.addEvent({
          sessionId: SESSION_ID,
          type: 'command-output',
          source: 'shell-integration',
          text: cap.text,
          range: null,
          parentId: null,
          truncated: cap.truncated,
        });
        send(CH.monitorEvent, { sessionId: SESSION_ID, event });
      },
      // Dismiss removes from the store so a reloaded pane's replay won't resurrect it;
      // removing a report cascades to its findings (§15.6 / v2.6).
      [CH.monitorDismiss]: (_e, m) => {
        if (isValidDismiss(m)) store.remove(m.eventId);
      },
      [CH.monitorDismissAll]: (_e, m) => {
        if (isValidDismissAll(m)) store.clear();
      },
      [CH.agentInject]: (_e, m) => {
        if (isValidInject(m)) inject(m.text, { submit: m.submit });
      },
    },
    {
      [CH.monitorReplay]: () => store.list(),
      [CH.monitorCommands]: (_e, m): CommandSummary[] =>
        isValidCommandsRequest(m)
          ? tracker.summaries().map((s) => ({ ...s, sessionId: SESSION_ID }))
          : [],
    },
  );

  win.on('closed', () => {
    disposeIpc();
    ptyProcess.kill();
    scanner.dispose();
    tracker.dispose();
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
