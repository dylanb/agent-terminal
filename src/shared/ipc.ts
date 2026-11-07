export type * from './ipc/settings';
export type * from './ipc/terminal';
export type * from './ipc/startup';
export type * from './ipc/monitor';
export type * from './ipc/todo';
export type * from './ipc/viewer';
export type * from './ipc/flow';
export type * from './ipc/install';
export type * from './ipc/controller';
export type * from './ipc/setup';
export { SESSION_ID, type ChannelSpec, type SessionId } from './ipc/session';
export { DEFAULT_UI_SETTINGS, isTheme } from './ipc/settings';
export { APP_ROUTE_OUT_ACTIONS, CATALOG_ORIGINS, GATE_DECISION_OPTIONS, hasFlowRefs } from './ipc/flow';
export { INSTALL_DESTINATION_IDS } from './ipc/install';
export { CONTROLLER_CHANNELS, CONTROLLER_DEFAULT_ALWAYS_ON_TOP, CONTROLLER_DEFAULT_SORT_MODE, CONTROLLER_DEFAULT_THEME, CONTROLLER_WINDOW_ARGUMENT, isControllerSortMode } from './ipc/controller';

import type { ControllerApi } from './ipc/controller';
import type { FlowApi, FlowAppBootstrapConflictMsg, FlowBootstrapErrorMsg, FlowEpicPromotionPreviewMsg, FlowRevealLoopMsg, FlowStateChangedMsg } from './ipc/flow';
import type { CliApi, ExamplesApi } from './ipc/install';
import type { CwdChangedMsg, MonitorApi, MonitorClearedMsg, MonitorEventMsg, MonitorEventRemovedMsg, MonitorUpdateMsg } from './ipc/monitor';
import type { MenuEditMsg, PtyDataMsg, PtyExitMsg, TermApi } from './ipc/terminal';
import type { ViewerApi, ViewerChangedMsg } from './ipc/viewer';
import type { SetupApi } from './ipc/setup';
import { channelNames } from './ipc/session';
import { TERMINAL_CHANNELS } from './ipc/terminal';
import { STARTUP_CHANNELS } from './ipc/startup';
import { MONITOR_CHANNELS } from './ipc/monitor';
import { SETTINGS_CHANNELS } from './ipc/settings';
import { TODO_CHANNELS } from './ipc/todo';
import { VIEWER_CHANNELS } from './ipc/viewer';
import { FLOW_CHANNELS } from './ipc/flow';
import { INSTALL_CHANNELS } from './ipc/install';
import { CONTROLLER_CHANNELS } from './ipc/controller';
import { SETUP_CHANNELS } from './ipc/setup';

export const CHANNELS = {
  ...TERMINAL_CHANNELS,
  ...STARTUP_CHANNELS,
  ...MONITOR_CHANNELS,
  ...SETTINGS_CHANNELS,
  ...TODO_CHANNELS,
  ...VIEWER_CHANNELS,
  ...FLOW_CHANNELS,
  ...INSTALL_CHANNELS,
  ...SETUP_CHANNELS,
};
export const CH = channelNames(CHANNELS);
export const CONTROLLER_CH = channelNames(CONTROLLER_CHANNELS);

/** Binds each main→renderer channel to its payload so emit sites stay type-checked (§6). */
export interface ChannelPayloads {
  'pty:data': PtyDataMsg;
  'pty:exit': PtyExitMsg;
  'monitor:event': MonitorEventMsg;
  'monitor:eventRemoved': MonitorEventRemovedMsg;
  'monitor:update': MonitorUpdateMsg;
  'monitor:cleared': MonitorClearedMsg;
  'cwd:changed': CwdChangedMsg;
  'viewer:onChanged': ViewerChangedMsg;
  'flow:onStateChanged': FlowStateChangedMsg;
  'menu:edit': MenuEditMsg;
  'flow:revealLoop': FlowRevealLoopMsg;
  'flow:onBootstrapError': FlowBootstrapErrorMsg;
  'flow:onAppBootstrapConflict': FlowAppBootstrapConflictMsg;
  'flow:onEpicPromotionPreview': FlowEpicPromotionPreviewMsg;
}

export type SendChannel = keyof ChannelPayloads;


declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
    viewer: ViewerApi;
    flow: FlowApi;
    cli: CliApi;
    examples: ExamplesApi;
    setup: SetupApi;
    controller: ControllerApi;
  }
}
