import { describe, expect, it } from 'vitest';
import * as ipc from '../../src/shared/ipc';
import { CH, CHANNELS, CONTROLLER_CH, CONTROLLER_CHANNELS, type ChannelSpec } from '../../src/shared/ipc';

const TERMINAL_WIRE_NAMES = {
  ptyData: 'pty:data',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyExit: 'pty:exit',
  startupReady: 'startup:ready',
  startupRendered: 'startup:rendered',
  startupIncompatible: 'startup:incompatible',
  monitorCapture: 'monitor:capture',
  monitorEvent: 'monitor:event',
  monitorEventRemoved: 'monitor:eventRemoved',
  monitorUpdate: 'monitor:update',
  monitorReplay: 'monitor:replay',
  monitorCurrentRepo: 'monitor:currentRepo',
  captureLast: 'capture:last',
  monitorDismiss: 'monitor:dismiss',
  monitorDismissAll: 'monitor:dismissAll',
  monitorCleared: 'monitor:cleared',
  monitorLearnChrome: 'monitor:learnChrome',
  agentInject: 'agent:inject',
  uiGetSettings: 'ui:getSettings',
  uiSetSettings: 'ui:setSettings',
  clipboardWrite: 'term:clipboardWrite',
  clipboardRead: 'term:clipboardRead',
  menuEdit: 'menu:edit',
  cwdChanged: 'cwd:changed',
  todoList: 'todo:list',
  todoAdd: 'todo:add',
  todoUpdate: 'todo:update',
  todoReorder: 'todo:reorder',
  todoSetStatus: 'todo:setStatus',
  todoDelete: 'todo:delete',
  viewerTree: 'viewer:tree',
  viewerRead: 'viewer:read',
  viewerOnChanged: 'viewer:onChanged',
  flowState: 'flow:state',
  flowStart: 'flow:start',
  flowAdvance: 'flow:advance',
  flowRestart: 'flow:restart',
  flowUndo: 'flow:undo',
  flowTerminate: 'flow:terminate',
  flowProvideInput: 'flow:provideInput',
  flowSetTitle: 'flow:setTitle',
  flowSetActiveFlow: 'flow:setActiveFlow',
  flowClearActiveFlow: 'flow:clearActiveFlow',
  flowListCatalog: 'flow:listCatalog',
  flowRebindHeldRun: 'flow:rebindHeldRun',
  flowConfirmRunPickup: 'flow:confirmRunPickup',
  flowOnStateChanged: 'flow:onStateChanged',
  flowRevealLoop: 'flow:revealLoop',
  flowOnBootstrapError: 'flow:onBootstrapError',
  flowOnLoopError: 'flow:onLoopError',
  flowOnAppBootstrapConflict: 'flow:onAppBootstrapConflict',
  flowResolveAppBootstrapConflict: 'flow:resolveAppBootstrapConflict',
  flowOnEpicPromotionPreview: 'flow:onEpicPromotionPreview',
  flowResolveEpicPromotion: 'flow:resolveEpicPromotion',
  flowGithubRef: 'flow:githubRef',
  flowAppRouteOut: 'flow:appRouteOut',
  flowAppGateDecision: 'flow:appGateDecision',
  flowAppRequestChanges: 'flow:appRequestChanges',
  flowAppRedo: 'flow:appRedo',
  flowAppBackToRed: 'flow:appBackToRed',
  flowArmInterrupt: 'flow:armInterrupt',
  appOpenExternal: 'app:openExternal',
  todoTemplateList: 'todoTemplate:list',
  todoTemplateInstantiate: 'todoTemplate:instantiate',
  cliInstall: 'cli:install',
  installExamplesPreview: 'examples:preview',
  installExamplesApply: 'examples:apply',
};

const CONTROLLER_WIRE_NAMES = {
  subscribe: 'controller:subscribe',
  terminals: 'controller:terminals',
  activate: 'controller:activate',
  dismiss: 'controller:dismiss',
  getTheme: 'controller:getTheme',
  setTheme: 'controller:setTheme',
  getAlwaysOnTop: 'controller:getAlwaysOnTop',
  setAlwaysOnTop: 'controller:setAlwaysOnTop',
  alwaysOnTop: 'controller:alwaysOnTop',
};

const notOneSentence = (does: string | undefined): boolean =>
  does === undefined || !/^\S[^]*[.]$/.test(does) || /[.!?]\s+[A-Z]/.test(does);

describe('IPC channel contract', () => {
  it('keeps every wire name the processes already speak', () => {
    expect({ terminal: CH, controller: CONTROLLER_CH }).toEqual({
      terminal: TERMINAL_WIRE_NAMES,
      controller: CONTROLLER_WIRE_NAMES,
    });
  });

  it('describes what every channel does in one sentence, beside its wire name', () => {
    const specs: Record<string, ChannelSpec | undefined> = { ...CHANNELS };
    const controllerSpecs: Record<string, ChannelSpec | undefined> = { ...CONTROLLER_CHANNELS };
    const missing = [
      ...Object.entries(CH).map(([key, name]) => ({ name, spec: specs[key] })),
      ...Object.entries(CONTROLLER_CH).map(([key, name]) => ({ name, spec: controllerSpecs[key] })),
    ]
      .filter(({ name, spec }) => spec?.name !== name || notOneSentence(spec?.does))
      .map(({ name }) => name);
    expect(missing).toEqual([]);
  });

  it('gives the terminal and controller channels distinct wire names', () => {
    const names: string[] = [...Object.values(CH), ...Object.values(CONTROLLER_CH)];
    expect(names.filter((name, i) => names.indexOf(name) !== i)).toEqual([]);
  });

  it('publishes the channels, their descriptions and the shared values, and nothing of how they are assembled', () => {
    expect(Object.keys(ipc).sort()).toEqual([
      'APP_ROUTE_OUT_ACTIONS',
      'CATALOG_ORIGINS',
      'CH',
      'CHANNELS',
      'CONTROLLER_CH',
      'CONTROLLER_CHANNELS',
      'CONTROLLER_DEFAULT_ALWAYS_ON_TOP',
      'CONTROLLER_DEFAULT_THEME',
      'CONTROLLER_WINDOW_ARGUMENT',
      'DEFAULT_UI_SETTINGS',
      'GATE_DECISION_OPTIONS',
      'INSTALL_DESTINATION_IDS',
      'SESSION_ID',
      'hasFlowRefs',
      'isTheme',
    ]);
  });
});
