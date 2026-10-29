import { ipcRenderer } from 'electron';
import { CONTROLLER_CH, SESSION_ID, type ControllerApi, type ControllerClearRequest, type ControllerSnapshot, type ControllerThemeChoice, type ControllerThemeRequest } from '../shared/ipc';

export const controllerApi: ControllerApi = {
  subscribeTerminals(listener) {
    const receive = (_event: Electron.IpcRendererEvent, payload: ControllerSnapshot) => listener(payload.terminals);
    ipcRenderer.on(CONTROLLER_CH.terminals, receive);
    ipcRenderer.send(CONTROLLER_CH.subscribe, { sessionId: SESSION_ID });
    return () => { ipcRenderer.removeListener(CONTROLLER_CH.terminals, receive); };
  },
  clearHistory: observed => ipcRenderer.invoke(CONTROLLER_CH.clearHistory, { sessionId: SESSION_ID, observed } satisfies ControllerClearRequest),
  dismissTerminal: id => ipcRenderer.invoke(CONTROLLER_CH.dismiss, { sessionId: SESSION_ID, id }),
  activateTerminal: id => ipcRenderer.invoke(CONTROLLER_CH.activate, { sessionId: SESSION_ID, id }),
  getTheme: () => ipcRenderer.invoke(CONTROLLER_CH.getTheme, { sessionId: SESSION_ID } satisfies ControllerThemeRequest),
  setTheme: theme => ipcRenderer.invoke(CONTROLLER_CH.setTheme, { sessionId: SESSION_ID, theme } satisfies ControllerThemeChoice),
};
