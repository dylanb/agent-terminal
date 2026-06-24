import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  SESSION_ID,
  type AgentInjectMsg,
  type ArtifactScope,
  type ArtifactTree,
  type CommandCaptureResult,
  type CommandSummary,
  type CwdChangedMsg,
  type FlowApi,
  type FlowStateView,
  type MonitorApi,
  type ViewerApi,
  type ViewerFile,
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
  type TodoTemplateList,
  type TodoSource,
  type TodoStatus,
  type UiSettings,
  type OsPlatform,
  type MenuEditMsg,
} from '../shared/ipc';

export const termApi: TermApi = {
  onData: (cb) => {
    const h = (_e: unknown, m: PtyDataMsg): void => cb(m.data);
    ipcRenderer.on(CH.ptyData, h);
    return () => ipcRenderer.removeListener(CH.ptyData, h);
  },
  onExit: (cb) => {
    const h = (_e: unknown, m: PtyExitMsg): void => cb(m);
    ipcRenderer.on(CH.ptyExit, h);
    return () => ipcRenderer.removeListener(CH.ptyExit, h);
  },
  input: (data) => ipcRenderer.send(CH.ptyInput, { sessionId: SESSION_ID, data }),
  resize: (size) => ipcRenderer.send(CH.ptyResize, { sessionId: SESSION_ID, ...size }),
  // Clipboard is owned by main (the sandboxed preload can't import electron's clipboard) — route via
  // IPC. Keeps the renderer off navigator.clipboard's focus/permission path (§9.1 / §7.7).
  clipboardWrite: (text) => ipcRenderer.send(CH.clipboardWrite, { text }),
  clipboardRead: () => ipcRenderer.invoke(CH.clipboardRead) as Promise<string>,
  platform: process.platform as OsPlatform,
  onMenuAction: (cb) => {
    const h = (_e: unknown, m: MenuEditMsg): void => cb(m.action);
    ipcRenderer.on(CH.menuEdit, h);
    return () => ipcRenderer.removeListener(CH.menuEdit, h);
  },
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
  // §16.6: app-wide, so no sessionId.
  getSettings: () => ipcRenderer.invoke(CH.uiGetSettings) as Promise<UiSettings>,
  setSettings: (settings) => ipcRenderer.send(CH.uiSetSettings, { settings }),
  onCwdChanged: (cb) => ipcRenderer.on(CH.cwdChanged, (_e, m: CwdChangedMsg) => cb(m)),
  clearCommands: () => ipcRenderer.send(CH.monitorClearCommands, { sessionId: SESSION_ID }),
  // §16.4: repoKey threaded so an in-flight edit always targets its own repo, not whatever cwd moved to.
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
  listTemplates: (repoKey) =>
    ipcRenderer.invoke(CH.todoTemplateList, { sessionId: SESSION_ID, repoKey }) as Promise<TodoTemplateList>,
  instantiateTemplate: (repoKey, ref) =>
    ipcRenderer.invoke(CH.todoTemplateInstantiate, { sessionId: SESSION_ID, repoKey, ref }) as Promise<TodoItem[]>,
};

export const viewerApi: ViewerApi = {
  tree: (scope: ArtifactScope) =>
    ipcRenderer.invoke(CH.viewerTree, { sessionId: SESSION_ID, scope }) as Promise<ArtifactTree>,
  read: (relPath) =>
    ipcRenderer.invoke(CH.viewerRead, { sessionId: SESSION_ID, relPath }) as Promise<ViewerFile | null>,
  onChanged: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(CH.viewerOnChanged, handler);
    return () => ipcRenderer.removeListener(CH.viewerOnChanged, handler);
  },
};

const flowApi: FlowApi = {
  state: (repoKey) => ipcRenderer.invoke(CH.flowState, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  start: (repoKey) => ipcRenderer.invoke(CH.flowStart, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  advance: (repoKey) => ipcRenderer.invoke(CH.flowAdvance, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  restart: (repoKey) => ipcRenderer.invoke(CH.flowRestart, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  undo: (repoKey) => ipcRenderer.invoke(CH.flowUndo, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  provideInput: (repoKey, values) =>
    ipcRenderer.invoke(CH.flowProvideInput, { sessionId: SESSION_ID, repoKey, values }) as Promise<FlowStateView>,
  onStateChanged: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(CH.flowOnStateChanged, handler);
    return () => ipcRenderer.removeListener(CH.flowOnStateChanged, handler);
  },
  onRevealLoop: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on(CH.flowRevealLoop, handler);
    return () => ipcRenderer.removeListener(CH.flowRevealLoop, handler);
  },
};

contextBridge.exposeInMainWorld('term', termApi);
contextBridge.exposeInMainWorld('monitor', monitorApi);
contextBridge.exposeInMainWorld('viewer', viewerApi);
contextBridge.exposeInMainWorld('flow', flowApi);
