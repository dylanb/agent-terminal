import { connect, type Socket } from 'node:net';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { controllerWebSocketOptions } from './controllerWebSocket';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveControllerEndpoint } from './controllerEndpoint';
import { randomUUID } from 'node:crypto';
import type { ControllerTerminal, ControllerClearTarget, ControllerClearOutcome, ControllerTimelineEntry } from '../shared/ipc';
import { CONTROLLER_LOOP_MESSAGE_MINOR, CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, CONTROLLER_SUPPORTED_MAJORS, supportsControllerNotifications, ControllerVersionMismatch, parseControllerMessage, encodeControllerMessage } from '../shared/controllerProtocol';
import { createControllerTimelines } from './controllerTimeline';
import { createWorktreeLock } from './worktreeLock';
import { isErrno } from './errno';
import { isPrivateDirectory } from './ownerOnlyPath';

export const CONTROLLER_ACTIVATION_TIMEOUT_MS = 5_000;

export interface ControllerRegistry {
  /** Returned and delivered snapshots are detached values owned by the caller. */
  terminals(): ControllerTerminal[];
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  activate(id: string): Promise<'activated' | 'unavailable'>;
  dismiss(id: string): void;
  clearHistory(target: ControllerClearTarget): ControllerClearOutcome;
  dismissLoopMessage(terminalId: string, messageId: string): void;
  dispose(): Promise<void>;
}

export async function startControllerTransport(appHome: string): Promise<ControllerRegistry> {
  const endpoint = resolveControllerEndpoint(appHome);
  const directory = dirname(endpoint);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!isPrivateDirectory(directoryStat, process.getuid?.() ?? -1)) {
    throw new Error('The controller endpoint directory must be owned by the current user with permissions 0700.');
  }
  const ownership = createWorktreeLock({ lockRoot: directory }).acquire(endpoint);
  if (!ownership.ok) throw new Error(ownership.reason);
  const sockets = new Set<Socket>();
  const registrations = new Map<WebSocket, ControllerTerminal>();
  const minors = new Map<WebSocket, number>();
  const retained = new Map<string, ControllerTerminal>();
  const timelines = createControllerTimelines<WebSocket>();
  const members = (directory: string) => [...registrations].filter(([, terminal]) => terminal.launchDirectory === directory);
  const overlapping = (directory: string) => members(directory).length > 1;
  const snapshot = () => structuredClone([...retained.values(), ...registrations.values()]);
  const pending = new Map<string, { socket: WebSocket; finish(outcome: 'activated' | 'unavailable'): void }>();
  const listeners = new Set<(terminals: ControllerTerminal[]) => void>();
  const notify = () => { for (const listener of listeners) listener(snapshot()); };
  const server = createServer((_request, response) => { response.writeHead(426); response.end(); });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const webSockets = new WebSocketServer({ server, ...controllerWebSocketOptions });
  webSockets.on('connection', socket => {
    let notificationsSupported = false;
    socket.on('error', () => socket.terminate());
    socket.on('close', () => {
      const terminal = registrations.get(socket);
      registrations.delete(socket);
      minors.delete(socket);
      if (terminal) {
        const remaining = members(terminal.launchDirectory);
        const card: ControllerTerminal = { ...terminal, work: undefined, status: 'disconnected' };
        timelines.departed(socket, card, remaining);
        if (!remaining.length) retained.set(card.id, card);
      }
      for (const request of pending.values()) if (request.socket === socket) request.finish('unavailable');
      notify();
    });
    socket.on('message', (chunk, binary) => {
      try {
        if (binary) throw new Error('Binary controller message');
        const message = parseControllerMessage(chunk.toString());
        if (message.type === 'register' && !registrations.has(socket)) {
          let timeline: ControllerTimelineEntry[] | undefined;
          for (const [id, terminal] of retained) {
            if (terminal.launchDirectory === message.launchDirectory) {
              timeline = terminal.timeline;
              retained.delete(id);
            }
          }
          notificationsSupported = supportsControllerNotifications(message.minor);
          const terminal: ControllerTerminal = { id: randomUUID(), launchDirectory: message.launchDirectory, repositoryRoot: message.repositoryRoot, ...(timeline ? { timeline } : {}) };
          registrations.set(socket, terminal);
          timelines.registered(socket, terminal, members(message.launchDirectory).map(([, peer]) => peer), notificationsSupported);
          minors.set(socket, message.minor ?? 0);
          notify();
          socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_PROTOCOL_MINOR, type: 'registered' }));
        } else if ((message.type === 'notification' || message.type === 'notification-current') && registrations.has(socket) && notificationsSupported) {
          const terminal = registrations.get(socket)!;
          const report = message.type === 'notification' ? 'arrival' : 'current';
          if (timelines.notified(socket, terminal, message.notification, report, overlapping(terminal.launchDirectory))) notify();
        } else if (message.type === 'status' && registrations.has(socket)) {
          const terminal = registrations.get(socket)!;
          terminal.work = message.work;
          timelines.reported(socket, terminal, message.work, overlapping(terminal.launchDirectory));
          notify();
        } else if (message.type === 'result') {
          const request = pending.get(message.requestId);
          if (request?.socket === socket) request.finish(message.outcome);
        } else {
          socket.terminate();
        }
      } catch (error) {
        if (error instanceof ControllerVersionMismatch && !registrations.has(socket)) {
          socket.send(encodeControllerMessage({ type: 'incompatible', supported: CONTROLLER_SUPPORTED_MAJORS }), () => socket.close());
        } else socket.terminate();
      }
    });
  });
  try {
    const existing = await lstat(endpoint).catch(error => {
      if (isErrno(error, 'ENOENT')) return null;
      throw error;
    });
    if (existing) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) {
        throw new Error('The controller endpoint is not an owned socket.');
      }
      await new Promise<void>((resolve, reject) => {
        const probe = connect(endpoint);
        probe.setTimeout(CONTROLLER_ACTIVATION_TIMEOUT_MS, () => {
          probe.destroy();
          reject(new Error('The controller endpoint did not respond.'));
        });
        probe.once('connect', () => {
          probe.destroy();
          reject(new Error('Another controller is already listening.'));
        });
        probe.once('error', error => {
          if (isErrno(error, 'ECONNREFUSED')) resolve();
          else reject(error);
        });
      });
      await unlink(endpoint);
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
  } catch (error) {
    webSockets.close();
    ownership.release();
    throw error;
  }
  return {
    terminals: snapshot,
    subscribeTerminals(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => { listeners.delete(listener); };
    },
    clearHistory(target) {
      const terminal = retained.get(target.id) ?? [...registrations.values()].find(item => item.id === target.id);
      if (!terminal || terminal.launchDirectory !== target.launchDirectory) return 'stale';
      const outcome = timelines.clear(terminal, target.revision, overlapping(terminal.launchDirectory));
      if (outcome === 'cleared') notify();
      return outcome;
    },
    dismiss(id) {
      const terminal = retained.get(id);
      if (terminal) {
        timelines.dismissed(terminal.launchDirectory);
        retained.delete(id);
        notify();
      }
    },
    dismissLoopMessage(terminalId, messageId) {
      const [socket, terminal] = [...registrations].find(([, registered]) => registered.id === terminalId) ?? [];
      if (!socket || socket.readyState !== WebSocket.OPEN || (minors.get(socket) ?? 0) < CONTROLLER_LOOP_MESSAGE_MINOR) return;
      if (terminal?.work?.loopMessage?.id !== messageId) return;
      socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'dismiss-loop-message', id: messageId }));
    },
    async activate(id) {
      const socket = [...registrations].find(([, terminal]) => terminal.id === id)?.[0];
      if (!socket || socket.readyState !== WebSocket.OPEN || pending.size >= 128) return 'unavailable';
      return new Promise<'activated' | 'unavailable'>(resolve => {
        const requestId = randomUUID();
        const finish = (outcome: 'activated' | 'unavailable') => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(outcome);
        };
        const timer = setTimeout(() => finish('unavailable'), CONTROLLER_ACTIVATION_TIMEOUT_MS);
        pending.set(requestId, { socket, finish });
        socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'activate', requestId }), error => {
          if (error) pending.get(requestId)?.finish('unavailable');
        });
      });
    },
    dispose: () => new Promise<void>((resolve, reject) => {
      listeners.clear();
      for (const request of pending.values()) request.finish('unavailable');
      for (const socket of webSockets.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      webSockets.close();
      server.close(error => {
        ownership.release();
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}
