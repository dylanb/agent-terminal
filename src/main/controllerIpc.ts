import { ipcMain, type WebContents } from 'electron';
import { CONTROLLER_CH, CONTROLLER_DEFAULT_THEME, isTheme, SESSION_ID, type ControllerActivation, type ControllerClearRequest, type ControllerClearOutcome, type ControllerSnapshot, type ControllerThemeChoice, type ControllerThemeRequest, type Theme } from '../shared/ipc';
import type { ControllerRegistry } from './controllerTransport';
import type { ControllerSettingsStore } from './controllerSettings';

export function installControllerIpc(
  contents: Pick<WebContents, 'isDestroyed' | 'send'>,
  controller: Pick<ControllerRegistry, 'terminals' | 'subscribeTerminals' | 'activate' | 'dismiss' | 'clearHistory'>,
  settings: ControllerSettingsStore,
): () => void {
  const send = (terminals: ControllerSnapshot['terminals']) => {
    if (!contents.isDestroyed()) contents.send(CONTROLLER_CH.terminals, { sessionId: SESSION_ID, terminals } satisfies ControllerSnapshot);
  };
  const unsubscribe = controller.subscribeTerminals(send);
  const subscribe = (event: Electron.IpcMainEvent) => {
    if (event.sender === contents) send(controller.terminals());
  };
  ipcMain.on(CONTROLLER_CH.subscribe, subscribe);
  ipcMain.handle(CONTROLLER_CH.activate, (event, payload: ControllerActivation) => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID || typeof payload.id !== 'string') return 'unavailable';
    return controller.activate(payload.id);
  });
  ipcMain.handle(CONTROLLER_CH.dismiss, (event, payload: ControllerActivation) => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID || typeof payload.id !== 'string') return;
    controller.dismiss(payload.id);
  });
  ipcMain.handle(CONTROLLER_CH.clearHistory, (event, payload: ControllerClearRequest): ControllerClearOutcome => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID
      || typeof payload.target?.id !== 'string' || !payload.target.id
      || typeof payload.target.launchDirectory !== 'string' || !payload.target.launchDirectory
      || typeof payload.target.revision !== 'string' || !payload.target.revision) return 'unavailable';
    return controller.clearHistory(payload.target);
  });
  ipcMain.handle(CONTROLLER_CH.getTheme, (event, payload: ControllerThemeRequest): Theme => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID) return CONTROLLER_DEFAULT_THEME;
    return settings.theme();
  });
  ipcMain.handle(CONTROLLER_CH.setTheme, (event, payload: ControllerThemeChoice) => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID || !isTheme(payload.theme)) return;
    settings.saveTheme(payload.theme);
  });
  return () => {
    unsubscribe();
    ipcMain.removeListener(CONTROLLER_CH.subscribe, subscribe);
    ipcMain.removeHandler(CONTROLLER_CH.activate);
    ipcMain.removeHandler(CONTROLLER_CH.dismiss);
    ipcMain.removeHandler(CONTROLLER_CH.clearHistory);
    ipcMain.removeHandler(CONTROLLER_CH.getTheme);
    ipcMain.removeHandler(CONTROLLER_CH.setTheme);
  };
}
