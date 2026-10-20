import { ipcRenderer } from 'electron';
import { CONTROLLER_CH, SESSION_ID, type ControllerApi, type ControllerSnapshot } from '../shared/ipc';

export const controllerApi: ControllerApi = {
  subscribeTerminals(listener) {
    const receive = (_event: Electron.IpcRendererEvent, payload: ControllerSnapshot) => listener(payload.terminals);
    ipcRenderer.on(CONTROLLER_CH.terminals, receive);
    ipcRenderer.send(CONTROLLER_CH.subscribe, { sessionId: SESSION_ID });
    return () => { ipcRenderer.removeListener(CONTROLLER_CH.terminals, receive); };
  },
  activateTerminal: id => ipcRenderer.invoke(CONTROLLER_CH.activate, { sessionId: SESSION_ID, id }),
};
