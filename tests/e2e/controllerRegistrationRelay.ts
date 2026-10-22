import { connect, createServer, type Socket } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createControllerDecoder, encodeControllerMessage, type ControllerMessage } from '../../src/shared/controllerProtocol';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';

interface RelayClient {
  terminal: Socket;
  upstream?: Socket;
  registration?: ControllerMessage;
  confirmed: boolean;
}

export async function createControllerRegistrationRelay(terminalHome: string, controllerHome: string) {
  const endpoint = resolveControllerEndpoint(terminalHome);
  mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
  const clients = new Set<RelayClient>();
  function attach(client: RelayClient): Promise<void> {
    const upstream = connect(resolveControllerEndpoint(controllerHome));
    client.upstream = upstream;
    const decoder = createControllerDecoder();
    return new Promise<void>((resolve, reject) => {
      upstream.on('error', reject);
      upstream.once('connect', () => {
        if (client.registration) upstream.write(encodeControllerMessage(client.registration));
      });
      upstream.on('data', (chunk: Buffer) => {
        for (const message of decoder.push(chunk)) {
          if (message.type === 'registered') {
            if (!client.confirmed) client.terminal.write(encodeControllerMessage(message));
            client.confirmed = true;
            resolve();
          } else client.terminal.write(encodeControllerMessage(message));
        }
      });
    });
  }
  const server = createServer(terminal => {
    const client: RelayClient = { terminal, confirmed: false };
    clients.add(client);
    terminal.on('error', () => terminal.destroy());
    terminal.once('close', () => { client.upstream?.destroy(); clients.delete(client); });
    const decoder = createControllerDecoder();
    terminal.on('data', (chunk: Buffer) => {
      for (const message of decoder.push(chunk)) {
        if (message.type === 'register') {
          client.registration = message;
          void attach(client).catch(() => terminal.destroy());
        } else client.upstream?.write(encodeControllerMessage(message));
      }
    });
  });
  await new Promise<void>(resolve => server.listen(endpoint, resolve));
  return {
    async replayRegistrations() {
      await Promise.all([...clients].map(client => {
        client.upstream?.destroy();
        return attach(client);
      }));
    },
    async dispose() {
      for (const client of clients) { client.upstream?.destroy(); client.terminal.destroy(); }
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
