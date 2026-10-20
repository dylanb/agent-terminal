import { createServer, type Socket } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ControllerTerminal } from '../shared/ipc';
import { createControllerDecoder, encodeControllerMessage } from '../shared/controllerProtocol';

export const CONTROLLER_ACTIVATION_TIMEOUT_MS = 5_000;

export function resolveControllerEndpoint(appHome: string): string {
  return join(appHome, 'controller', 'socket');
}

export async function startControllerTransport(appHome: string): Promise<{
  terminals(): ControllerTerminal[];
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  activate(id: string): Promise<'activated' | 'unavailable'>;
  dispose(): Promise<void>;
}> {
  const endpoint = resolveControllerEndpoint(appHome);
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  const sockets = new Set<Socket>();
  const registrations = new Map<Socket, ControllerTerminal>();
  const listeners = new Set<(terminals: ControllerTerminal[]) => void>();
  const notify = () => { for (const listener of listeners) listener([...registrations.values()]); };
  const server = createServer(socket => {
    sockets.add(socket);
    const decoder = createControllerDecoder();
    socket.on('close', () => { sockets.delete(socket); registrations.delete(socket); notify(); });
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) {
          if (message.type === 'register' && !registrations.has(socket)) {
            registrations.set(socket, { id: randomUUID(), launchDirectory: message.launchDirectory, repositoryRoot: message.repositoryRoot });
            notify();
          }
        }
      } catch { socket.destroy(); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  return {
    terminals: () => [...registrations.values()],
    subscribeTerminals(listener) {
      listeners.add(listener);
      listener([...registrations.values()]);
      return () => { listeners.delete(listener); };
    },
    async activate(id) {
      for (const [socket, terminal] of registrations) {
        if (terminal.id === id) socket.write(encodeControllerMessage({ version: 1, type: 'activate', requestId: randomUUID() }));
      }
      return 'unavailable';
    },
    dispose: () => new Promise<void>((resolve, reject) => {
      listeners.clear();
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
