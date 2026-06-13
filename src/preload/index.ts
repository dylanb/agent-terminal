import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  SESSION_ID,
  type AgentInjectMsg,
  type CommandSummary,
  type MonitorApi,
  type MonitorCaptureMsg,
  type MonitorEvent,
  type MonitorEventMsg,
  type MonitorUpdateMsg,
  type PtyDataMsg,
  type PtyExitMsg,
  type TermApi,
  type UiSettings,
} from '../shared/ipc';

const termApi: TermApi = {
  onData: (cb) => ipcRenderer.on(CH.ptyData, (_e, m: PtyDataMsg) => cb(m.data)),
  onExit: (cb) => ipcRenderer.on(CH.ptyExit, (_e, m: PtyExitMsg) => cb(m)),
  input: (data) => ipcRenderer.send(CH.ptyInput, { sessionId: SESSION_ID, data }),
  resize: (size) => ipcRenderer.send(CH.ptyResize, { sessionId: SESSION_ID, ...size }),
};

const monitorApi: MonitorApi = {
  capture: (block) =>
    ipcRenderer.send(CH.monitorCapture, { sessionId: SESSION_ID, ...block } satisfies MonitorCaptureMsg),
  onEvent: (cb) => ipcRenderer.on(CH.monitorEvent, (_e, m: MonitorEventMsg) => cb(m.event)),
  onUpdate: (cb) => ipcRenderer.on(CH.monitorUpdate, (_e, m: MonitorUpdateMsg) => cb(m)),
  onExit: (cb) => ipcRenderer.on(CH.ptyExit, (_e, m: PtyExitMsg) => cb(m)),
  replay: () => ipcRenderer.invoke(CH.monitorReplay) as Promise<MonitorEvent[]>,
  commands: () =>
    ipcRenderer.invoke(CH.monitorCommands, { sessionId: SESSION_ID }) as Promise<CommandSummary[]>,
  onCommandsChanged: (cb) => ipcRenderer.on(CH.monitorCommandsChanged, () => cb()),
  captureCommand: (commandId) =>
    ipcRenderer.send(CH.monitorCaptureCommand, { sessionId: SESSION_ID, commandId }),
  dismiss: (eventId) => ipcRenderer.send(CH.monitorDismiss, { sessionId: SESSION_ID, eventId }),
  dismissAll: () => ipcRenderer.send(CH.monitorDismissAll, { sessionId: SESSION_ID }),
  inject: (req) =>
    ipcRenderer.send(CH.agentInject, { sessionId: SESSION_ID, ...req } satisfies AgentInjectMsg),
  // Global UI prefs (§16.6) — no sessionId; app-wide, not per-session.
  getSettings: () => ipcRenderer.invoke(CH.uiGetSettings) as Promise<UiSettings>,
  setSettings: (settings) => ipcRenderer.send(CH.uiSetSettings, { settings }),
};

contextBridge.exposeInMainWorld('term', termApi);
contextBridge.exposeInMainWorld('monitor', monitorApi);
