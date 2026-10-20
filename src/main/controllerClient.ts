import { connect, type Socket } from 'node:net';
import { resolveControllerEndpoint } from './controllerTransport';
import { createControllerDecoder, encodeControllerMessage } from '../shared/controllerProtocol';
import type { ControllerIdentity } from './controllerIdentity';

export function registerControllerTerminal(appHome: string, identity: ControllerIdentity, activate: () => 'activated' | 'unavailable'): () => void {
  let socket: Socket;
  try { socket = connect(resolveControllerEndpoint(appHome)); }
  catch { return () => {}; }
  socket.on('error', () => socket.destroy());
  socket.once('connect', () => socket.write(encodeControllerMessage({ version: 1, type: 'register', ...identity })));
  const decoder = createControllerDecoder();
  socket.on('data', (chunk: Buffer) => {
    try {
      for (const message of decoder.push(chunk)) {
        if (message.type !== 'activate') { socket.destroy(); break; }
        const outcome = activate();
        socket.write(encodeControllerMessage({ version: 1, type: 'result', requestId: message.requestId, outcome }));
      }
    } catch { socket.destroy(); }
  });
  return () => { socket.destroy(); };
}
