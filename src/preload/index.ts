import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { controllerApi } from './controller';
import { CONTROLLER_WINDOW_ARGUMENT } from '../shared/ipc';
import {
  CH,
  SESSION_ID,
  type AgentInjectMsg,
  type ArtifactScope,
  type ArtifactTree,
  type CliApi,
  type CliInstallResult,
  type ExamplesApi,
  type InstallExamplesPreview,
  type InstallExamplesResult,
  type InstallExamplesApplyMsg,
  type CwdChangedMsg,
  type FlowApi,
  type FlowBootstrapErrorMsg,
  type FlowAppBootstrapConflictMsg,
  type FlowAdoptTicketChoiceMsg,
  type ResolveAdoptTicketResult,
  type FlowEpicPromotionPreviewMsg,
  type FlowStateView,
  type ActiveFlowWriteResult,
  type FlowCatalogListResult,
  type RebindResult,
  type ConfirmRunPickupResult,
  type GithubRef,
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
  type StartupIncompatibleMsg,
} from '../shared/ipc';

export const termApi: TermApi = {
  startup: {
    ready: () => ipcRenderer.invoke(CH.startupReady, { sessionId: SESSION_ID }) as Promise<void>,
    rendered: () => ipcRenderer.send(CH.startupRendered, { sessionId: SESSION_ID }),
    onIncompatible: (cb) => {
      const h = (_e: unknown, { sessionId: _sessionId, ...report }: StartupIncompatibleMsg): void => cb(report);
      ipcRenderer.on(CH.startupIncompatible, h);
      return () => ipcRenderer.removeListener(CH.startupIncompatible, h);
    },
  },
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
  pathForFile: (file) => webUtils.getPathForFile(file),
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
  captureLast: () => ipcRenderer.invoke(CH.captureLast, { sessionId: SESSION_ID }) as Promise<MonitorEvent[]>,
  dismiss: (eventId) => ipcRenderer.send(CH.monitorDismiss, { sessionId: SESSION_ID, eventId }),
  dismissAll: () => ipcRenderer.send(CH.monitorDismissAll, { sessionId: SESSION_ID }),
  onCleared: (cb) => ipcRenderer.on(CH.monitorCleared, () => cb()),
  learnChrome: (eventId, sample) =>
    ipcRenderer.send(CH.monitorLearnChrome, { sessionId: SESSION_ID, eventId, sample }),
  inject: (req) =>
    ipcRenderer.send(CH.agentInject, { sessionId: SESSION_ID, ...req } satisfies AgentInjectMsg),
  // §16.6: app-wide, so no sessionId.
  getSettings: () => ipcRenderer.invoke(CH.uiGetSettings) as Promise<UiSettings>,
  setSettings: (settings) => ipcRenderer.send(CH.uiSetSettings, { settings }),
  onCwdChanged: (cb) => ipcRenderer.on(CH.cwdChanged, (_e, m: CwdChangedMsg) => cb(m)),
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
  advance: (repoKey, step) => ipcRenderer.invoke(CH.flowAdvance, { sessionId: SESSION_ID, repoKey, step }) as Promise<FlowStateView>,
  restart: (repoKey) => ipcRenderer.invoke(CH.flowRestart, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  undo: (repoKey) => ipcRenderer.invoke(CH.flowUndo, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  terminate: (repoKey) => ipcRenderer.invoke(CH.flowTerminate, { sessionId: SESSION_ID, repoKey }) as Promise<FlowStateView>,
  provideInput: (repoKey, step, values) =>
    ipcRenderer.invoke(CH.flowProvideInput, { sessionId: SESSION_ID, repoKey, step, values }) as Promise<FlowStateView>,
  setTitle: (repoKey, title) =>
    ipcRenderer.invoke(CH.flowSetTitle, { sessionId: SESSION_ID, repoKey, title }) as Promise<FlowStateView>,
  setActiveFlow: (repoKey, id) =>
    ipcRenderer.invoke(CH.flowSetActiveFlow, { sessionId: SESSION_ID, repoKey, id }) as Promise<ActiveFlowWriteResult>,
  clearActiveFlow: (repoKey) =>
    ipcRenderer.invoke(CH.flowClearActiveFlow, { sessionId: SESSION_ID, repoKey }) as Promise<ActiveFlowWriteResult>,
  listCatalog: (repoKey) =>
    ipcRenderer.invoke(CH.flowListCatalog, { sessionId: SESSION_ID, repoKey }) as Promise<FlowCatalogListResult>,
  rebindHeldRun: (repoKey, choice, ifStepMissing) =>
    ipcRenderer.invoke(CH.flowRebindHeldRun, { sessionId: SESSION_ID, repoKey, choice, ifStepMissing }) as Promise<RebindResult>,
  confirmRunPickup: (repoKey, run, pr, ticket) =>
    ipcRenderer.invoke(CH.flowConfirmRunPickup, { sessionId: SESSION_ID, repoKey, run, pr, ticket }) as Promise<ConfirmRunPickupResult>,
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
  onBootstrapError: (cb) => {
    const handler = (_e: unknown, msg: FlowBootstrapErrorMsg): void => cb(msg.reason, msg.repoKey, msg.step);
    ipcRenderer.on(CH.flowOnBootstrapError, handler);
    return () => ipcRenderer.removeListener(CH.flowOnBootstrapError, handler);
  },
  onAppBootstrapConflict: (cb) => {
    const handler = (_e: unknown, msg: FlowAppBootstrapConflictMsg): void =>
      cb({
        repository: msg.repository,
        branch: msg.branch,
        localOid: msg.localOid,
        remoteOid: msg.remoteOid,
        pullRequests: msg.pullRequests,
        repoKey: msg.repoKey,
        step: msg.step,
      });
    ipcRenderer.on(CH.flowOnAppBootstrapConflict, handler);
    return () => ipcRenderer.removeListener(CH.flowOnAppBootstrapConflict, handler);
  },
  resolveAppBootstrapConflict: (repoKey, step, wipe, target) =>
    ipcRenderer.send(CH.flowResolveAppBootstrapConflict, {
      sessionId: SESSION_ID,
      repoKey,
      step,
      wipe,
      ...target,
    }),
  onAdoptTicketChoice: (cb) => {
    const handler = (_e: unknown, msg: FlowAdoptTicketChoiceMsg): void =>
      cb({
        repoKey: msg.repoKey,
        step: msg.step,
        pr: msg.pr,
        choiceId: msg.choiceId,
        tickets: msg.tickets.map((t) => ({ repo: t.repo, number: t.number })),
      });
    ipcRenderer.on(CH.flowOnAdoptTicketChoice, handler);
    return () => ipcRenderer.removeListener(CH.flowOnAdoptTicketChoice, handler);
  },
  resolveAdoptTicket: (repoKey, step, choiceId, answer) =>
    ipcRenderer.invoke(CH.flowResolveAdoptTicket, { sessionId: SESSION_ID, repoKey, step, choiceId, answer }) as Promise<ResolveAdoptTicketResult>,
  onEpicPromotionPreview: (cb) => {
    const handler = (_e: unknown, msg: FlowEpicPromotionPreviewMsg): void =>
      cb({ repoKey: msg.repoKey, step: msg.step, epic: msg.epic, pr: msg.pr, subTickets: msg.subTickets });
    ipcRenderer.on(CH.flowOnEpicPromotionPreview, handler);
    return () => ipcRenderer.removeListener(CH.flowOnEpicPromotionPreview, handler);
  },
  resolveEpicPromotion: (repoKey, step, confirm) =>
    ipcRenderer.send(CH.flowResolveEpicPromotion, { sessionId: SESSION_ID, repoKey, step, confirm }),
  githubRef: (repoKey, kind, number) =>
    ipcRenderer.invoke(CH.flowGithubRef, { sessionId: SESSION_ID, repoKey, kind, number }) as Promise<GithubRef | null>,
  openExternal: (url) => ipcRenderer.invoke(CH.appOpenExternal, { sessionId: SESSION_ID, url }) as Promise<boolean>,
  appRouteOut: (repoKey, step, turnKey, action) =>
    ipcRenderer.send(CH.flowAppRouteOut, { sessionId: SESSION_ID, repoKey, step, turnKey, action }),
  appGateDecision: (repoKey, step, turnKey, option) =>
    ipcRenderer.invoke(CH.flowAppGateDecision, { sessionId: SESSION_ID, repoKey, step, turnKey, option }) as Promise<boolean>,
  appRequestChanges: (repoKey, step, turnKey, feedback) =>
    ipcRenderer.invoke(CH.flowAppRequestChanges, { sessionId: SESSION_ID, repoKey, step, turnKey, feedback }) as Promise<boolean>,
  appRedo: (repoKey, step, turnKey, instruction) =>
    ipcRenderer.invoke(CH.flowAppRedo, { sessionId: SESSION_ID, repoKey, step, turnKey, instruction }) as Promise<boolean>,
  appBackToRed: (repoKey, step, turnKey, brief) =>
    ipcRenderer.invoke(CH.flowAppBackToRed, { sessionId: SESSION_ID, repoKey, step, turnKey, brief }) as Promise<boolean>,
  armInterrupt: (repoKey, step) => ipcRenderer.send(CH.flowArmInterrupt, { sessionId: SESSION_ID, repoKey, step }),
};

export const cliApi: CliApi = {
  install: () => ipcRenderer.invoke(CH.cliInstall, { sessionId: SESSION_ID }) as Promise<CliInstallResult>,
};

export const examplesApi: ExamplesApi = {
  preview: () =>
    ipcRenderer.invoke(CH.installExamplesPreview, { sessionId: SESSION_ID }) as Promise<InstallExamplesPreview>,
  apply: (previewId, replace, removeRetired) =>
    ipcRenderer.invoke(CH.installExamplesApply, {
      sessionId: SESSION_ID,
      previewId,
      replace,
      removeRetired,
    } satisfies InstallExamplesApplyMsg) as Promise<InstallExamplesResult>,
};

if (process.argv.includes(CONTROLLER_WINDOW_ARGUMENT)) {
  contextBridge.exposeInMainWorld('controller', controllerApi);
} else {
  contextBridge.exposeInMainWorld('term', termApi);
  contextBridge.exposeInMainWorld('monitor', monitorApi);
  contextBridge.exposeInMainWorld('viewer', viewerApi);
  contextBridge.exposeInMainWorld('flow', flowApi);
  contextBridge.exposeInMainWorld('cli', cliApi);
  contextBridge.exposeInMainWorld('examples', examplesApi);
}
