import { connect, type Socket } from 'node:net';
import { resolveControllerEndpoint } from './controllerTransport';
import { encodeControllerMessage } from '../shared/controllerProtocol';
import type { ControllerIdentity } from './controllerIdentity';

export function registerControllerTerminal(appHome: string, identity: ControllerIdentity): () => void {
  let socket: Socket;
  try { socket = connect(resolveControllerEndpoint(appHome)); }
  catch { return () => {}; }
  socket.on('error', () => socket.destroy());
  socket.once('connect', () => socket.write(encodeControllerMessage({ version: 1, type: 'register', ...identity })));
  socket.resume();
  return () => { socket.destroy(); };
}
