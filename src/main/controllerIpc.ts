import { ipcMain, type WebContents } from 'electron';
import { CONTROLLER_CH, SESSION_ID, type ControllerActivation, type ControllerSnapshot } from '../shared/ipc';
import type { ControllerRegistry } from './controllerTransport';
import type { ControllerSettingsStore } from './controllerSettings';

export function installControllerIpc(
  contents: Pick<WebContents, 'isDestroyed' | 'send'>,
  controller: Pick<ControllerRegistry, 'terminals' | 'subscribeTerminals' | 'activate' | 'dismiss'>,
  _settings?: ControllerSettingsStore,
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
  return () => {
    unsubscribe();
    ipcMain.removeListener(CONTROLLER_CH.subscribe, subscribe);
    ipcMain.removeHandler(CONTROLLER_CH.activate);
    ipcMain.removeHandler(CONTROLLER_CH.dismiss);
  };
}
