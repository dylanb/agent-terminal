import type { ControllerTerminal } from './ipc';

export const CONTROLLER_MAX_MESSAGE_BYTES = 16 * 1024;

export type ControllerMessage =
  | ({ version: 1; type: 'register' } & Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>)
  | { version: 1; type: 'activate'; requestId: string }
  | { version: 1; type: 'result'; requestId: string; outcome: 'activated' | 'unavailable' };

export function encodeControllerMessage(message: ControllerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function parseControllerMessage(frame: string): ControllerMessage {
  if (new TextEncoder().encode(frame).length > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
  const value: unknown = JSON.parse(frame);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid controller message');
  const message = value as Record<string, unknown>;
  const absolutePath = (path: unknown) => typeof path === 'string' && path.startsWith('/') && !path.includes('\0');
  const requestId = typeof message.requestId === 'string' && message.requestId.length > 0;
  let keys: string[];
  switch (message.type) {
    case 'register':
      if (!absolutePath(message.launchDirectory) || (message.repositoryRoot !== null && !absolutePath(message.repositoryRoot))) throw new Error('Invalid controller identity');
      keys = ['version', 'type', 'launchDirectory', 'repositoryRoot'];
      break;
    case 'activate':
      if (!requestId) throw new Error('Invalid activation request');
      keys = ['version', 'type', 'requestId'];
      break;
    case 'result':
      if (!requestId || (message.outcome !== 'activated' && message.outcome !== 'unavailable')) throw new Error('Invalid activation result');
      keys = ['version', 'type', 'requestId', 'outcome'];
      break;
    default: throw new Error('Unknown controller message');
  }
  if (message.version !== 1 || Object.keys(message).some(key => !keys.includes(key))) throw new Error('Incompatible controller message');
  return message as ControllerMessage;
}

export function createControllerDecoder(): { push(chunk: Uint8Array): ControllerMessage[] } {
  let pending = new Uint8Array(0);
  return { push(chunk) {
    const combined = new Uint8Array(pending.length + chunk.length);
    combined.set(pending);
    combined.set(chunk, pending.length);
    pending = combined;
    const messages: ControllerMessage[] = [];
    for (let delimiter = pending.indexOf(10); delimiter !== -1; delimiter = pending.indexOf(10)) {
      if (delimiter > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
      messages.push(parseControllerMessage(new TextDecoder().decode(pending.subarray(0, delimiter))));
      pending = pending.subarray(delimiter + 1);
    }
    if (pending.length > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
    return messages;
  } };
}
