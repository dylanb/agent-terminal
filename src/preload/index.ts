import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  SESSION_ID,
  type AgentInjectMsg,
  type CommandCaptureResult,
  type CommandSummary,
  type CwdChangedMsg,
  type MonitorApi,
  type MonitorCaptureMsg,
  type MonitorEvent,
  type MonitorEventMsg,
  type MonitorEventRemovedMsg,
  type MonitorUpdateMsg,
  type PtyDataMsg,
  type PtyExitMsg,
  type RepoInfo,
  type TermApi,
  type TodoItem,
  type TodoSource,
  type TodoStatus,
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
  onEventRemoved: (cb) =>
    ipcRenderer.on(CH.monitorEventRemoved, (_e, m: MonitorEventRemovedMsg) => cb(m.eventId)),
  onUpdate: (cb) => ipcRenderer.on(CH.monitorUpdate, (_e, m: MonitorUpdateMsg) => cb(m)),
  onExit: (cb) => ipcRenderer.on(CH.ptyExit, (_e, m: PtyExitMsg) => cb(m)),
  replay: () => ipcRenderer.invoke(CH.monitorReplay) as Promise<MonitorEvent[]>,
  currentRepo: () =>
    ipcRenderer.invoke(CH.monitorCurrentRepo, { sessionId: SESSION_ID }) as Promise<RepoInfo | null>,
  commands: () =>
    ipcRenderer.invoke(CH.monitorCommands, { sessionId: SESSION_ID }) as Promise<CommandSummary[]>,
  onCommandsChanged: (cb) => ipcRenderer.on(CH.monitorCommandsChanged, () => cb()),
  captureCommandText: (commandId) =>
    ipcRenderer.invoke(CH.monitorCaptureCommandText, {
      sessionId: SESSION_ID,
      commandId,
    }) as Promise<CommandCaptureResult | null>,
  captureLast: () => ipcRenderer.invoke(CH.captureLast, { sessionId: SESSION_ID }) as Promise<MonitorEvent[]>,
  dismiss: (eventId) => ipcRenderer.send(CH.monitorDismiss, { sessionId: SESSION_ID, eventId }),
  dismissAll: () => ipcRenderer.send(CH.monitorDismissAll, { sessionId: SESSION_ID }),
  learnChrome: (eventId, sample) =>
    ipcRenderer.send(CH.monitorLearnChrome, { sessionId: SESSION_ID, eventId, sample }),
  inject: (req) =>
    ipcRenderer.send(CH.agentInject, { sessionId: SESSION_ID, ...req } satisfies AgentInjectMsg),
  // Global UI prefs (§16.6) — no sessionId; app-wide, not per-session.
  getSettings: () => ipcRenderer.invoke(CH.uiGetSettings) as Promise<UiSettings>,
  setSettings: (settings) => ipcRenderer.send(CH.uiSetSettings, { settings }),
  onCwdChanged: (cb) => ipcRenderer.on(CH.cwdChanged, (_e, m: CwdChangedMsg) => cb(m)),
  clearCommands: () => ipcRenderer.send(CH.monitorClearCommands, { sessionId: SESSION_ID }),
  // Todo (§16.4) — repoKey threaded so an in-flight edit always targets its own repo.
  todoList: (repoKey) => ipcRenderer.invoke(CH.todoList, { sessionId: SESSION_ID, repoKey }) as Promise<TodoItem[]>,
  todoAdd: (repoKey, text, source?: TodoSource) =>
    ipcRenderer.invoke(CH.todoAdd, { sessionId: SESSION_ID, repoKey, text, source }) as Promise<TodoItem[]>,
  todoUpdate: (repoKey, id, text) =>
    ipcRenderer.invoke(CH.todoUpdate, { sessionId: SESSION_ID, repoKey, id, text }) as Promise<TodoItem[]>,
  todoReorder: (repoKey, orderedIds) =>
    ipcRenderer.invoke(CH.todoReorder, { sessionId: SESSION_ID, repoKey, orderedIds }) as Promise<TodoItem[]>,
  todoSetStatus: (repoKey, id, status: TodoStatus) =>
    ipcRenderer.invoke(CH.todoSetStatus, { sessionId: SESSION_ID, repoKey, id, status }) as Promise<TodoItem[]>,
  todoDelete: (repoKey, id) =>
    ipcRenderer.invoke(CH.todoDelete, { sessionId: SESSION_ID, repoKey, id }) as Promise<TodoItem[]>,
};

contextBridge.exposeInMainWorld('term', termApi);
contextBridge.exposeInMainWorld('monitor', monitorApi);
