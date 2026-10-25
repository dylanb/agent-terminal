import { isControllerWorkStatus } from './controllerStatus';
import type { ControllerWorkStatus, ControllerTerminal, ControllerVersionRange } from './ipc';

export const CONTROLLER_MAX_MESSAGE_BYTES = 16 * 1024;
export const CONTROLLER_MAX_STATUS_BYTES = 1024 * 1024;

// §23.6
export const CONTROLLER_PROTOCOL_MAJOR = 2;
export const CONTROLLER_PROTOCOL_MINOR = 0;
export const CONTROLLER_SUPPORTED_MAJORS: ControllerVersionRange = { min: 2, max: 2 };

export class ControllerVersionMismatch extends Error {
  constructor(readonly version: number) { super(`Unsupported controller protocol version ${version}`); }
}

export type ControllerMessage =
  | { version: typeof CONTROLLER_PROTOCOL_MAJOR; type: 'status'; work: ControllerWorkStatus }
  | { type: 'incompatible'; supported: ControllerVersionRange }
  | { version: typeof CONTROLLER_PROTOCOL_MAJOR; minor?: number; type: 'registered' }
  | ({ version: typeof CONTROLLER_PROTOCOL_MAJOR; minor?: number; type: 'register' } & Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>)
  | { version: typeof CONTROLLER_PROTOCOL_MAJOR; type: 'activate'; requestId: string }
  | { version: typeof CONTROLLER_PROTOCOL_MAJOR; type: 'result'; requestId: string; outcome: 'activated' | 'unavailable' };

const FIELDS: { [Type in Exclude<ControllerMessage['type'], 'incompatible'>]: readonly (keyof Extract<ControllerMessage, { type: Type }>)[] } = {
  status: ['version', 'type', 'work'],
  register: ['version', 'minor', 'type', 'launchDirectory', 'repositoryRoot'],
  registered: ['version', 'minor', 'type'],
  activate: ['version', 'type', 'requestId'],
  result: ['version', 'type', 'requestId', 'outcome'],
};

export function encodeControllerMessage(message: ControllerMessage): string {
  if ('minor' in message && message.minor === 0) {
    const { minor: _minor, ...withoutMinor } = message;
    return JSON.stringify(withoutMinor);
  }
  let json = JSON.stringify(message);
  if (message.type === 'status' && new TextEncoder().encode(json).length > CONTROLLER_MAX_STATUS_BYTES) {
    json = JSON.stringify({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'status', work: {
      flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' },
      activity: 'unavailable', attention: null, error: null, unavailableReason: 'message-too-large',
    } satisfies ControllerWorkStatus });
  }
  return json;
}

export function parseControllerMessage(frame: string): ControllerMessage {
  const bytes = new TextEncoder().encode(frame).length;
  if (bytes > CONTROLLER_MAX_STATUS_BYTES) throw new Error('Controller message exceeds byte limit');
  const value: unknown = JSON.parse(frame);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid controller message');
  const message = value as Record<string, unknown>;
  if (message.type !== 'status' && bytes > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller control message exceeds byte limit');
  const version = (field: unknown): field is number => Number.isSafeInteger(field) && (field as number) >= 0;
  if (message.type === 'incompatible') {
    const supported = message.supported as Record<string, unknown> | null;
    if (typeof supported !== 'object' || supported === null || !version(supported.min) || !version(supported.max) || supported.min > supported.max) {
      throw new Error('Invalid controller version range');
    }
    return { type: 'incompatible', supported: { min: supported.min, max: supported.max } };
  }
  const absolutePath = (path: unknown) => typeof path === 'string' && path.startsWith('/') && !path.includes('\0');
  if (!version(message.version)) throw new Error('Invalid controller protocol version');
  if (message.version !== CONTROLLER_PROTOCOL_MAJOR) throw new ControllerVersionMismatch(message.version);
  const requestId = typeof message.requestId === 'string' && message.requestId.length > 0;
  switch (message.type) {
    case 'status':
      if (!isControllerWorkStatus(message.work)) throw new Error('Invalid controller status');
      break;
    case 'register':
      if (!absolutePath(message.launchDirectory) || (message.repositoryRoot !== null && !absolutePath(message.repositoryRoot))) throw new Error('Invalid controller identity');
      break;
    case 'registered':
      break;
    case 'activate':
      if (!requestId) throw new Error('Invalid activation request');
      break;
    case 'result':
      if (!requestId || (message.outcome !== 'activated' && message.outcome !== 'unavailable')) throw new Error('Invalid activation result');
      break;
    default: throw new Error('Unknown controller message');
  }
  const fields: readonly string[] = FIELDS[message.type];
  if (fields.includes('minor')) {
    message.minor ??= 0;
    if (!version(message.minor)) throw new Error('Invalid controller minor version');
  }
  return Object.fromEntries(fields.map(field => [field, message[field]])) as ControllerMessage;
}

export function controllerUpdateTarget(terminalVersion: number, controllerVersions: ControllerVersionRange): 'controller' | 'terminal' {
  return terminalVersion > controllerVersions.max ? 'controller' : 'terminal';
}
