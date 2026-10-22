import { isControllerWorkStatus } from './controllerStatus';
import type { ControllerWorkStatus, ControllerTerminal } from './ipc';

export const CONTROLLER_MAX_MESSAGE_BYTES = 16 * 1024;
export const CONTROLLER_MAX_STATUS_BYTES = 1024 * 1024;
export const CONTROLLER_MAX_STATUS_PARTS = 1024;
export const CONTROLLER_TRANSFER_TIMEOUT_MS = 5_000;

export type ControllerMessage =
  | { version: 1; type: 'status'; work: ControllerWorkStatus }
  | { version: 1; type: 'status-part'; text: string; last: boolean }
  | { version: 1; type: 'registered' }
  | ({ version: 1; type: 'register' } & Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>)
  | { version: 1; type: 'activate'; requestId: string }
  | { version: 1; type: 'result'; requestId: string; outcome: 'activated' | 'unavailable' };

export function encodeControllerMessage(message: ControllerMessage): string {
  let json = JSON.stringify(message);
  if (message.type === 'status' && new TextEncoder().encode(json).length > CONTROLLER_MAX_STATUS_BYTES) {
    json = JSON.stringify({ version: 1, type: 'status', work: {
      flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' },
      activity: 'unavailable', attention: null, error: null, unavailableReason: 'message-too-large',
    } satisfies ControllerWorkStatus });
  }
  if (message.type === 'status' && new TextEncoder().encode(json).length > CONTROLLER_MAX_MESSAGE_BYTES) {
    const frames: string[] = [];
    for (let offset = 0; offset < json.length; offset += 2000) {
      frames.push(JSON.stringify({ version: 1, type: 'status-part', text: json.slice(offset, offset + 2000), last: offset + 2000 >= json.length }));
    }
    return frames.join('\n') + '\n';
  }
  return `${json}\n`;
}

export function parseControllerMessage(frame: string): ControllerMessage {
  if (new TextEncoder().encode(frame).length > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
  return validateControllerMessage(JSON.parse(frame));
}

function validateControllerMessage(value: unknown): ControllerMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid controller message');
  const message = value as Record<string, unknown>;
  const absolutePath = (path: unknown) => typeof path === 'string' && path.startsWith('/') && !path.includes('\0');
  const requestId = typeof message.requestId === 'string' && message.requestId.length > 0;
  let keys: string[];
  switch (message.type) {
    case 'status':
      if (!isControllerWorkStatus(message.work)) throw new Error('Invalid controller status');
      keys = ['version', 'type', 'work'];
      break;
    case 'status-part':
      if (typeof message.text !== 'string' || message.text.length === 0 || typeof message.last !== 'boolean') throw new Error('Invalid status fragment');
      keys = ['version', 'type', 'text', 'last'];
      break;
    case 'register':
      if (!absolutePath(message.launchDirectory) || (message.repositoryRoot !== null && !absolutePath(message.repositoryRoot))) throw new Error('Invalid controller identity');
      keys = ['version', 'type', 'launchDirectory', 'repositoryRoot'];
      break;
    case 'registered':
      keys = ['version', 'type'];
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

/** A decoder owns one connection; expiry and disposal release all retained input. */
export function createControllerDecoder(onExpired: () => void = () => {}): {
  push(chunk: Uint8Array): ControllerMessage[];
  dispose(): void;
} {
  let pending = new Uint8Array(0);
  let parts: string[] = [];
  let partBytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const clearDeadline = () => { clearTimeout(timer); timer = undefined; };
  const dispose = () => {
    closed = true;
    clearDeadline();
    pending = new Uint8Array(0);
    parts = [];
    partBytes = 0;
  };
  const startDeadline = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => { dispose(); onExpired(); }, CONTROLLER_TRANSFER_TIMEOUT_MS);
  };
  const consume = (frame: Uint8Array): ControllerMessage | undefined => {
    const message = parseControllerMessage(new TextDecoder().decode(frame));
    if (message.type !== 'status-part') {
      if (parts.length) throw new Error('Interrupted status');
      clearDeadline();
      return message;
    }
    // UTF-16 fragments may divide a surrogate pair. Count its joined UTF-8 size exactly.
    const previous = parts.at(-1);
    const high = previous?.charCodeAt(previous.length - 1) ?? 0;
    const low = message.text.charCodeAt(0);
    const joinedPair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    const nextBytes = partBytes + new TextEncoder().encode(message.text).length - (joinedPair ? 2 : 0);
    if (nextBytes > CONTROLLER_MAX_STATUS_BYTES || parts.length >= CONTROLLER_MAX_STATUS_PARTS) {
      throw new Error('Controller status exceeds assembly limit');
    }
    startDeadline();
    partBytes = nextBytes;
    parts.push(message.text);
    if (!message.last) return;
    const complete = validateControllerMessage(JSON.parse(parts.join('')));
    if (complete.type !== 'status') throw new Error('Invalid assembled status');
    parts = [];
    partBytes = 0;
    clearDeadline();
    return complete;
  };
  return {
    dispose,
    push(chunk) {
      if (closed) throw new Error('Controller decoder closed');
      const messages: ControllerMessage[] = [];
      try {
        // Inspect one bounded frame at a time, without copying an entire socket read.
        let offset = 0;
        while (offset < chunk.length) {
          const delimiter = chunk.indexOf(10, offset);
          const end = delimiter === -1 ? chunk.length : delimiter;
          const length = pending.length + end - offset;
          if (length > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
          const frame = new Uint8Array(length);
          frame.set(pending);
          frame.set(chunk.subarray(offset, end), pending.length);
          pending = new Uint8Array(0);
          if (delimiter === -1) {
            pending = frame;
            startDeadline();
            break;
          }
          const message = consume(frame);
          if (message) messages.push(message);
          offset = delimiter + 1;
        }
        return messages;
      } catch (error) {
        dispose();
        throw error;
      }
    },
  };
}
