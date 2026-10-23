import { isControllerWorkStatus } from './controllerStatus';
import type { ControllerWorkStatus, ControllerTerminal } from './ipc';

export const CONTROLLER_MAX_MESSAGE_BYTES = 16 * 1024;
export const CONTROLLER_MAX_STATUS_BYTES = 1024 * 1024;

export type ControllerMessage =
  | { version: 1; type: 'status'; work: ControllerWorkStatus }
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
  return json;
}

export function parseControllerMessage(frame: string): ControllerMessage {
  const bytes = new TextEncoder().encode(frame).length;
  if (bytes > CONTROLLER_MAX_STATUS_BYTES) throw new Error('Controller message exceeds byte limit');
  const message = validateControllerMessage(JSON.parse(frame));
  if (message.type !== 'status' && bytes > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller control message exceeds byte limit');
  return message;
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
