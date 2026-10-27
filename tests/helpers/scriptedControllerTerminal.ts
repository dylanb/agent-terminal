import WebSocket from 'ws';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerTerminal, ControllerWorkStatus } from '../../src/shared/ipc';
import { connectWebSocket } from './controllerWebSocket';

export interface ScriptedControllerTerminal {
  sendStatus(work: ControllerWorkStatus): Promise<void>;
  close(): Promise<void>;
}

/** Stands in for a terminal on the real controller's endpoint under `controllerHome`; resolves once registered. */
export async function connectScriptedTerminal(
  controllerHome: string,
  identity: Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>,
): Promise<ScriptedControllerTerminal> {
  const socket = connectWebSocket(resolveControllerEndpoint(controllerHome));
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  const close = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.once('close', () => reject(new Error('Controller closed the connection before registering the terminal')));
      socket.once('open', () => {
        socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_PROTOCOL_MINOR, type: 'register', ...identity }));
      });
      socket.on('message', (chunk: Buffer) => {
        const message = parseControllerMessage(chunk.toString());
        if (message.type === 'registered') resolve();
        else if (message.type === 'incompatible') reject(new Error(`Controller supports protocol ${message.supported.min}–${message.supported.max}`));
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    sendStatus: work => new Promise<void>((resolve, reject) => {
      socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'status', work }), error => (error ? reject(error) : resolve()));
    }),
    close,
  };
}
