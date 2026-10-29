import type { ControllerIncompatibility, ControllerWorkStatus } from '../shared/ipc';
import { connect } from 'node:net';
import WebSocket from 'ws';
import { controllerWebSocketOptions } from './controllerWebSocket';
import { resolveControllerEndpoint } from './controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, CONTROLLER_PROTOCOL_MINOR, CONTROLLER_MAX_STATUS_BYTES, supportsControllerNotifications, type ControllerNotificationSource, type ControllerMessage, controllerUpdateTarget, parseControllerMessage, encodeControllerMessage } from '../shared/controllerProtocol';
import type { ControllerIdentity } from './controllerIdentity';

export const CONTROLLER_REGISTRATION_DEADLINE_MS = 2_000;
export const CONTROLLER_RETRY_DELAY_MS = 5_000;

export function registerControllerTerminal(
  appHome: string,
  identity: ControllerIdentity,
  activate: () => 'activated' | 'unavailable',
  onRegistered: () => void = () => {},
  subscribeStatus?: (listener: (work: ControllerWorkStatus) => void) => () => void,
  onIncompatible: (report: ControllerIncompatibility) => void = () => {},
  notifications?: ControllerNotificationSource,
): () => void {
  let canceled = false;
  let started = false;
  let socket: WebSocket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const scheduleRetry = () => {
    if (!canceled) retry = setTimeout(attempt, CONTROLLER_RETRY_DELAY_MS);
  };
  const attempt = () => {
    if (canceled) return;
    let registered = false;
    let unsubscribe: (() => void) | undefined;
    let unsubscribeNotifications: (() => void) | undefined;
    let sendingStatus = false;
    let pendingStatus: ControllerWorkStatus | undefined;
    let current: WebSocket;
    try {
      // A literal socket path also supports ':' and '?', which ws+unix URLs cannot encode.
      current = new WebSocket('ws://localhost', {
        ...controllerWebSocketOptions,
        createConnection: () => connect(resolveControllerEndpoint(appHome)),
      });
    } catch { scheduleRetry(); return; }
    socket = current;
    const publishStatus = (work: ControllerWorkStatus) => {
      if (canceled || current.readyState !== WebSocket.OPEN) return;
      if (sendingStatus) {
        pendingStatus = work;
        return;
      }
      sendingStatus = true;
      current.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'status', work }), error => {
        sendingStatus = false;
        if (error) { current.terminate(); return; }
        const latest = pendingStatus;
        pendingStatus = undefined;
        if (latest) publishStatus(latest);
      });
    };
    deadline = setTimeout(() => current.terminate(), CONTROLLER_REGISTRATION_DEADLINE_MS);
    current.on('error', () => current.terminate());
    current.once('close', () => {
      clearTimeout(deadline);
      unsubscribe?.();
      unsubscribeNotifications?.();
      pendingStatus = undefined;
      socket = undefined;
      scheduleRetry();
    });
    current.once('open', () => {
      if (!canceled) current.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, minor: CONTROLLER_PROTOCOL_MINOR, type: 'register', ...identity }));
    });
    current.on('message', (chunk, binary) => {
      if (canceled || current.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw new Error('Binary controller message');
        const message = parseControllerMessage(chunk.toString());
        if (!registered && message.type === 'registered') {
          registered = true;
          clearTimeout(deadline);
          if (notifications && supportsControllerNotifications(message.minor)) {
            const publishNotification = (frame: ControllerMessage) => {
              if (canceled || current.readyState !== WebSocket.OPEN) return;
              try {
                const encoded = encodeControllerMessage(frame);
                if (current.bufferedAmount + Buffer.byteLength(encoded) > CONTROLLER_MAX_STATUS_BYTES) {
                  current.terminate();
                  return;
                }
                current.send(encoded, error => { if (error) current.terminate(); });
              } catch { current.terminate(); }
            };
            publishNotification({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'notification-current', notification: notifications.current() });
            unsubscribeNotifications = notifications.subscribe(notification => publishNotification({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'notification', notification }));
          }
          unsubscribe = subscribeStatus?.(publishStatus);
          if (!started) {
            started = true;
            onRegistered();
          }
        } else if (!registered && message.type === 'incompatible') {
          onIncompatible({
            update: controllerUpdateTarget(CONTROLLER_PROTOCOL_MAJOR, message.supported),
            terminalVersion: CONTROLLER_PROTOCOL_MAJOR,
            controllerVersions: message.supported,
          });
          current.terminate();
        } else if (registered && message.type === 'activate') {
          const outcome = activate();
          current.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'result', requestId: message.requestId, outcome }));
        } else {
          current.terminate();
        }
      } catch { current.terminate(); }
    });
  };
  attempt();
  return () => {
    canceled = true;
    clearTimeout(deadline);
    clearTimeout(retry);
    socket?.terminate();
  };
}
