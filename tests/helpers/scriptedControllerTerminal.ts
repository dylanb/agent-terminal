import WebSocket from 'ws';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
import type { ControllerTerminal, ControllerWorkStatus } from '../../src/shared/ipc';
import { connectWebSocket } from './controllerWebSocket';

export interface ScriptedControllerTerminal {
  sendStatus(work: ControllerWorkStatus): Promise<void>;
  activations(): number;
  /** The loop message ids the controller asked this terminal to dismiss, in order. */
  loopMessageDismissals(): string[];
  close(): Promise<void>;
}

export async function connectScriptedTerminal(
  controllerHome: string,
  identity: Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>,
  minor: number = CONTROLLER_PROTOCOL_MINOR,
): Promise<ScriptedControllerTerminal> {
  const socket = connectWebSocket(resolveControllerEndpoint(controllerHome));
  const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
  const close = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await closed;
  };
  let activations = 0;
  const loopMessageDismissals: string[] = [];
  socket.on('message', (chunk: Buffer) => {
    const message = parseControllerMessage(chunk.toString());
    if (message.type === 'dismiss-loop-message') loopMessageDismissals.push(message.id);
    if (message.type !== 'activate') return;
    activations++;
    socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'result', requestId: message.requestId, outcome: 'activated' }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on('error', reject);
      socket.once('close', () => reject(new Error('Controller closed the connection before registering the terminal')));
      socket.once('open', () => {
        socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor, type: 'register', ...identity }));
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
    activations: () => activations,
    loopMessageDismissals: () => [...loopMessageDismissals],
    close,
  };
}
