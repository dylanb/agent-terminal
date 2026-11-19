import { randomBytes } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { bridgeLineReader, encodeBridgeMessage, type McpCaller, type WindowRequest } from '../shared/mcpBridge';
import { errMsg, isErrno } from './errno';
import { preparePrivateDir } from './ownedDir';

export interface WindowBridge {
  readonly endpoint: string;
  close(): Promise<void>;
}

export function windowBridgeDir(appHome: string): string {
  return join(appHome, '.agent-terminal', 'mcp');
}

interface WindowBridgeOptions {
  appHome: string;
  build: string;
  handle: (request: WindowRequest, caller: McpCaller) => Promise<unknown>;
}

export async function openWindowBridge(opts: WindowBridgeOptions): Promise<WindowBridge> {
  const dir = windowBridgeDir(opts.appHome);
  if (!await preparePrivateDir(dir)) throw new Error(`The MCP endpoint directory ${dir} must be owned by the current user with permissions 0700.`);
  const endpoint = join(dir, `${randomBytes(6).toString('hex')}.sock`);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let stage: 'hello' | 'call' | 'answering' = 'hello';
    socket.on('data', bridgeLineReader((message) => {
      if (stage === 'hello' && message?.type === 'hello') {
        if (message.build !== opts.build) {
          socket.end(encodeBridgeMessage({ type: 'other-build' }));
          stage = 'answering';
          return;
        }
        stage = 'call';
        socket.write(encodeBridgeMessage({ type: 'ack' }));
        return;
      }
      if (stage === 'call' && message?.type === 'call') {
        stage = 'answering';
        const { request, caller } = message;
        Promise.resolve()
          .then(() => opts.handle(request, caller))
          .then((value) => encodeBridgeMessage({ type: 'result', value }))
          .then(
            (line) => {
              if (!socket.destroyed) socket.end(line);
            },
            (error: unknown) => {
              console.error(`MCP ${request.tool} call failed in the window: ${errMsg(error)}`);
              if (!socket.destroyed) socket.end(encodeBridgeMessage({ type: 'failed', reason: errMsg(error) }));
            },
          );
        return;
      }
      if (stage !== 'answering') socket.destroy();
    }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.on('error', (error) => console.error(`The MCP window bridge failed: ${errMsg(error)}`));
  let closing: Promise<void> | undefined;
  return {
    endpoint,
    close: () => (closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(endpoint).catch((error: unknown) => {
        if (!isErrno(error, 'ENOENT')) throw error;
      });
    })()),
  };
}

export async function openWindowBridgeForLifetime(opts: WindowBridgeOptions & {
  lifetime: { isClosed(): boolean; onClosed(close: () => void): void };
}): Promise<WindowBridge | null> {
  const bridge = await openWindowBridge(opts);
  const close = () => bridge.close().catch((error: unknown) => console.error(`The Claude Code tools' endpoint was not closed: ${errMsg(error)}`));
  opts.lifetime.onClosed(() => { void close(); });
  if (opts.lifetime.isClosed()) {
    await close();
    return null;
  }
  return bridge;
}
