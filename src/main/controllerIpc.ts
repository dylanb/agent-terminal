import { ipcMain, type WebContents } from 'electron';
import { CONTROLLER_CH, CONTROLLER_DEFAULT_ALWAYS_ON_TOP, CONTROLLER_DEFAULT_THEME, isTheme, SESSION_ID, type ControllerActivation, type ControllerAlwaysOnTopChoice, type ControllerAlwaysOnTopRequest, type ControllerSnapshot, type ControllerThemeChoice, type ControllerThemeRequest, type Theme } from '../shared/ipc';
import type { ControllerRegistry } from './controllerTransport';
import type { ControllerSettingsStore } from './controllerSettings';
import type { ControllerAlwaysOnTop } from './controllerAlwaysOnTop';

export function installControllerIpc(
  contents: Pick<WebContents, 'isDestroyed' | 'send'>,
  controller: Pick<ControllerRegistry, 'terminals' | 'subscribeTerminals' | 'activate' | 'dismiss'>,
  settings: ControllerSettingsStore,
  alwaysOnTop: ControllerAlwaysOnTop,
): () => void {
  const send = (terminals: ControllerSnapshot['terminals']) => {
    if (!contents.isDestroyed()) contents.send(CONTROLLER_CH.terminals, { sessionId: SESSION_ID, terminals } satisfies ControllerSnapshot);
  };
  const unsubscribe = controller.subscribeTerminals(send);
  const unsubscribeAlwaysOnTop = alwaysOnTop.subscribe(value => {
    if (!contents.isDestroyed()) contents.send(CONTROLLER_CH.alwaysOnTop, { sessionId: SESSION_ID, alwaysOnTop: value } satisfies ControllerAlwaysOnTopChoice);
  });
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
  ipcMain.handle(CONTROLLER_CH.getTheme, (event, payload: ControllerThemeRequest): Theme => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID) return CONTROLLER_DEFAULT_THEME;
    return settings.theme();
  });
  ipcMain.handle(CONTROLLER_CH.setTheme, (event, payload: ControllerThemeChoice) => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID || !isTheme(payload.theme)) return;
    settings.saveTheme(payload.theme);
  });
  ipcMain.handle(CONTROLLER_CH.getAlwaysOnTop, (event, payload: ControllerAlwaysOnTopRequest): boolean => {
    if (event.sender !== contents || payload?.sessionId !== SESSION_ID) return CONTROLLER_DEFAULT_ALWAYS_ON_TOP;
    return alwaysOnTop.current();
  });
  ipcMain.handle(CONTROLLER_CH.setAlwaysOnTop, (event, payload: ControllerAlwaysOnTopChoice): boolean => {
    if (event.sender === contents && payload?.sessionId === SESSION_ID && typeof payload.alwaysOnTop === 'boolean') alwaysOnTop.set(payload.alwaysOnTop);
    return alwaysOnTop.current();
  });
  return () => {
    unsubscribe();
    unsubscribeAlwaysOnTop();
    ipcMain.removeListener(CONTROLLER_CH.subscribe, subscribe);
    ipcMain.removeHandler(CONTROLLER_CH.activate);
    ipcMain.removeHandler(CONTROLLER_CH.dismiss);
    ipcMain.removeHandler(CONTROLLER_CH.getTheme);
    ipcMain.removeHandler(CONTROLLER_CH.setTheme);
    ipcMain.removeHandler(CONTROLLER_CH.getAlwaysOnTop);
    ipcMain.removeHandler(CONTROLLER_CH.setAlwaysOnTop);
  };
}
