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
  return JSON.parse(frame) as ControllerMessage;
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
