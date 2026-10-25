import WebSocket from 'ws';
import { connectWebSocket, createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseControllerMessage, encodeControllerMessage, type ControllerMessage } from '../../src/shared/controllerProtocol';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';

interface RelayClient {
  terminal: WebSocket;
  upstream?: WebSocket;
  registration?: ControllerMessage;
  confirmed: boolean;
}

export async function createControllerRegistrationRelay(terminalHome: string, controllerHome: string) {
  const endpoint = resolveControllerEndpoint(terminalHome);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const clients = new Set<RelayClient>();
  function attach(client: RelayClient): Promise<void> {
    const upstream = connectWebSocket(resolveControllerEndpoint(controllerHome));
    client.upstream = upstream;
    return new Promise<void>((resolve, reject) => {
      upstream.on('error', reject);
      upstream.once('open', () => {
        if (client.registration) upstream.send(encodeControllerMessage(client.registration));
      });
      upstream.on('message', (chunk: Buffer) => {
        const message = parseControllerMessage(chunk.toString());
        if (message.type === 'registered') {
          if (!client.confirmed) client.terminal.send(encodeControllerMessage(message));
          client.confirmed = true;
          resolve();
        } else client.terminal.send(encodeControllerMessage(message));
      });
    });
  }
  const server = createWebSocketTestServer(terminal => {
    const client: RelayClient = { terminal, confirmed: false };
    clients.add(client);
    terminal.on('error', () => terminal.terminate());
    terminal.once('close', () => { client.upstream?.terminate(); clients.delete(client); });
    terminal.on('message', (chunk: Buffer) => {
      const message = parseControllerMessage(chunk.toString());
      if (message.type === 'register') {
        client.registration = message;
        void attach(client).catch(() => terminal.terminate());
      } else if (client.upstream?.readyState === WebSocket.OPEN) client.upstream.send(encodeControllerMessage(message));
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return {
    async replayRegistrations() {
      await Promise.all([...clients].map(client => {
        client.upstream?.terminate();
        return attach(client);
      }));
    },
    async dispose() {
      for (const client of clients) { client.upstream?.terminate(); client.terminal.terminate(); }
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
