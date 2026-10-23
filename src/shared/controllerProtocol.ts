import type { ControllerTerminal, ControllerVersionRange } from './ipc';

export const CONTROLLER_MAX_MESSAGE_BYTES = 16 * 1024;

// §23.6
export const CONTROLLER_PROTOCOL_MAJOR = 1;
export const CONTROLLER_PROTOCOL_MINOR = 0;
export const CONTROLLER_SUPPORTED_MAJORS: ControllerVersionRange = { min: 1, max: 1 };

export class ControllerVersionMismatch extends Error {
  constructor(readonly version: number) { super(`Unsupported controller protocol version ${version}`); }
}

export type ControllerMessage =
  | { type: 'incompatible'; supported: ControllerVersionRange }
  | { version: 1; minor: number; type: 'registered' }
  | ({ version: 1; minor: number; type: 'register' } & Pick<ControllerTerminal, 'launchDirectory' | 'repositoryRoot'>)
  | { version: 1; type: 'activate'; requestId: string }
  | { version: 1; type: 'result'; requestId: string; outcome: 'activated' | 'unavailable' };

const FIELDS: { [Type in Exclude<ControllerMessage['type'], 'incompatible'>]: readonly (keyof Extract<ControllerMessage, { type: Type }>)[] } = {
  register: ['version', 'minor', 'type', 'launchDirectory', 'repositoryRoot'],
  registered: ['version', 'minor', 'type'],
  activate: ['version', 'type', 'requestId'],
  result: ['version', 'type', 'requestId', 'outcome'],
};

export function encodeControllerMessage(message: ControllerMessage): string {
  // Builds that predate minor versions reject a `minor` key, so minor 0 is written in their shape.
  if ('minor' in message && message.minor === 0) {
    const { minor: _minor, ...protocol10 } = message;
    return `${JSON.stringify(protocol10)}\n`;
  }
  return `${JSON.stringify(message)}\n`;
}

export function parseControllerMessage(frame: string): ControllerMessage {
  if (new TextEncoder().encode(frame).length > CONTROLLER_MAX_MESSAGE_BYTES) throw new Error('Controller frame exceeds byte limit');
  const value: unknown = JSON.parse(frame);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid controller message');
  const message = value as Record<string, unknown>;
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

export function controllerUpdateTarget(terminalVersion: number, controllerVersions: ControllerVersionRange): 'controller' | 'terminal' {
  return terminalVersion > controllerVersions.max ? 'controller' : 'terminal';
}
