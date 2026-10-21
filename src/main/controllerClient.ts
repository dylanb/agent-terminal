import { connect, type Socket } from 'node:net';
import { resolveControllerEndpoint } from './controllerEndpoint';
import { createControllerDecoder, encodeControllerMessage } from '../shared/controllerProtocol';
import type { ControllerIdentity } from './controllerIdentity';

export const CONTROLLER_REGISTRATION_DEADLINE_MS = 2_000;
export const CONTROLLER_RETRY_DELAY_MS = 5_000;

export function registerControllerTerminal(
  appHome: string,
  identity: ControllerIdentity,
  activate: () => 'activated' | 'unavailable',
  onRegistered: () => void = () => {},
): () => void {
  let canceled = false;
  let started = false;
  let socket: Socket | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const scheduleRetry = () => {
    if (!canceled) retry = setTimeout(attempt, CONTROLLER_RETRY_DELAY_MS);
  };
  const attempt = () => {
    if (canceled) return;
    let registered = false;
    let current: Socket;
    try { current = connect(resolveControllerEndpoint(appHome)); }
    catch { scheduleRetry(); return; }
    socket = current;
    const decoder = createControllerDecoder();
    deadline = setTimeout(() => current.destroy(), CONTROLLER_REGISTRATION_DEADLINE_MS);
    current.on('error', () => current.destroy());
    current.once('close', () => {
      clearTimeout(deadline);
      socket = undefined;
      scheduleRetry();
    });
    current.once('connect', () => {
      if (!canceled) current.write(encodeControllerMessage({ version: 1, type: 'register', ...identity }));
    });
    current.on('data', (chunk: Buffer) => {
      if (canceled || current.destroyed) return;
      try {
        for (const message of decoder.push(chunk)) {
          if (!registered && message.type === 'registered') {
            registered = true;
            clearTimeout(deadline);
            if (!started) {
              started = true;
              onRegistered();
            }
          } else if (registered && message.type === 'activate') {
            const outcome = activate();
            current.write(encodeControllerMessage({ version: 1, type: 'result', requestId: message.requestId, outcome }));
          } else {
            current.destroy();
            break;
          }
        }
      } catch { current.destroy(); }
    });
  };
  attempt();
  return () => {
    canceled = true;
    clearTimeout(deadline);
    clearTimeout(retry);
    socket?.destroy();
  };
}
