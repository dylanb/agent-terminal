import { ipcRenderer } from 'electron';
import { CONTROLLER_CH, SESSION_ID, type ControllerApi, type ControllerClearRequest, type ControllerAlwaysOnTopChoice, type ControllerLoopMessageDismissal, type ControllerAlwaysOnTopRequest, type ControllerSnapshot, type ControllerSortModeChoice, type ControllerSortModeRequest, type ControllerThemeChoice, type ControllerThemeRequest } from '../shared/ipc';

export const controllerApi: ControllerApi = {
  subscribeTerminals(listener) {
    const receive = (_event: Electron.IpcRendererEvent, payload: ControllerSnapshot) => listener(payload.terminals);
    ipcRenderer.on(CONTROLLER_CH.terminals, receive);
    ipcRenderer.send(CONTROLLER_CH.subscribe, { sessionId: SESSION_ID });
    return () => { ipcRenderer.removeListener(CONTROLLER_CH.terminals, receive); };
  },
  clearHistory: target => ipcRenderer.invoke(CONTROLLER_CH.clearHistory, { sessionId: SESSION_ID, target } satisfies ControllerClearRequest),
  dismissTerminal: id => ipcRenderer.invoke(CONTROLLER_CH.dismiss, { sessionId: SESSION_ID, id }),
  dismissLoopMessage: (terminalId, messageId) => ipcRenderer.invoke(CONTROLLER_CH.dismissLoopMessage, { sessionId: SESSION_ID, terminalId, messageId } satisfies ControllerLoopMessageDismissal),
  activateTerminal: id => ipcRenderer.invoke(CONTROLLER_CH.activate, { sessionId: SESSION_ID, id }),
  getTheme: () => ipcRenderer.invoke(CONTROLLER_CH.getTheme, { sessionId: SESSION_ID } satisfies ControllerThemeRequest),
  setTheme: theme => ipcRenderer.invoke(CONTROLLER_CH.setTheme, { sessionId: SESSION_ID, theme } satisfies ControllerThemeChoice),
  getSortMode: () => ipcRenderer.invoke(CONTROLLER_CH.getSortMode, { sessionId: SESSION_ID } satisfies ControllerSortModeRequest),
  setSortMode: sortMode => ipcRenderer.invoke(CONTROLLER_CH.setSortMode, { sessionId: SESSION_ID, sortMode } satisfies ControllerSortModeChoice),
  getAlwaysOnTop: () => ipcRenderer.invoke(CONTROLLER_CH.getAlwaysOnTop, { sessionId: SESSION_ID } satisfies ControllerAlwaysOnTopRequest),
  setAlwaysOnTop: alwaysOnTop => ipcRenderer.invoke(CONTROLLER_CH.setAlwaysOnTop, { sessionId: SESSION_ID, alwaysOnTop } satisfies ControllerAlwaysOnTopChoice),
  onAlwaysOnTopChanged(listener) {
    const receive = (_event: Electron.IpcRendererEvent, payload: ControllerAlwaysOnTopChoice) => listener(payload.alwaysOnTop);
    ipcRenderer.on(CONTROLLER_CH.alwaysOnTop, receive);
    return () => { ipcRenderer.removeListener(CONTROLLER_CH.alwaysOnTop, receive); };
  },
};
