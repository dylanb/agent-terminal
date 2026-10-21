import { describe, expect, it } from 'vitest';
import { createControllerDecoder, encodeControllerMessage, parseControllerMessage, CONTROLLER_MAX_MESSAGE_BYTES } from '../../src/shared/controllerProtocol';

const registration = { version: 1, type: 'register', launchDirectory: '/tmp/project', repositoryRoot: null } as const;

describe('controller wire protocol', () => {
  it('accepts the explicit registration confirmation shared by controller and terminal', () => {
    const confirmation = { version: 1, type: 'registered' };
    let parsed: unknown;
    try { parsed = parseControllerMessage(JSON.stringify(confirmation)); } catch { parsed = null; }
    expect(parsed).toEqual(confirmation);
  });

  it.each([
    registration,
    { version: 1, type: 'activate', requestId: 'request-a' },
    { version: 1, type: 'result', requestId: 'request-a', outcome: 'activated' },
    { version: 1, type: 'result', requestId: 'request-a', outcome: 'unavailable' },
  ] as const)('round trips $type messages', message => {
    expect(parseControllerMessage(encodeControllerMessage(message).trimEnd())).toEqual(message);
  });

  it.each([
    { ...registration, version: 2 },
    { ...registration, type: 'instruction', command: 'echo unsafe' },
    { ...registration, launchDirectory: '../relative' },
    { ...registration, repositoryRoot: 42 },
    { ...registration, command: 'echo unsafe' },
    { version: 1, type: 'activate', requestId: '' },
    { version: 1, type: 'activate', requestId: 'request-a', pid: 1234 },
    { version: 1, type: 'result', requestId: 'request-a', outcome: 'queued' },
    null,
    [],
  ])('rejects incompatible or malformed peer input %#', value => {
    expect(() => parseControllerMessage(JSON.stringify(value))).toThrow();
  });

  it.each(['x', 'é'])('rejects oversized %s frames by bytes before accepting their content', character => {
    const oversized = JSON.stringify({ ...registration, launchDirectory: `/${character.repeat(CONTROLLER_MAX_MESSAGE_BYTES / Buffer.byteLength(character))}` });
    expect(() => parseControllerMessage(oversized)).toThrow();
  });

  it('bounds incomplete input before its delimiter arrives', () => {
    const decoder = createControllerDecoder();
    expect(() => decoder.push(Buffer.alloc(CONTROLLER_MAX_MESSAGE_BYTES + 1, 120))).toThrow();
  });

  it('delivers a fragmented multibyte path once its complete frame arrives', () => {
    const decoder = createControllerDecoder();
    const message = { ...registration, launchDirectory: '/tmp/café' };
    const frame = Buffer.from(encodeControllerMessage(message));
    const split = frame.indexOf(Buffer.from('é')) + 1;
    expect.soft(decoder.push(frame.subarray(0, split))).toEqual([]);
    expect.soft(decoder.push(frame.subarray(split))).toEqual([message]);
  });

  it('delivers coalesced frames in their received order', () => {
    const decoder = createControllerDecoder();
    const next = { version: 1, type: 'result', requestId: 'request-b', outcome: 'unavailable' } as const;
    expect(decoder.push(Buffer.from(encodeControllerMessage(registration) + encodeControllerMessage(next)))).toEqual([registration, next]);
  });

  it.each(['not JSON\n', `${JSON.stringify({ ...registration, version: 2 })}\n`])('rejects invalid complete frames at the stream boundary %#', frame => {
    const decoder = createControllerDecoder();
    expect(() => decoder.push(Buffer.from(frame))).toThrow();
  });

  it('keeps hostile-looking directory labels as literal data', () => {
    const message = { ...registration, launchDirectory: '/tmp/$(echo unsafe)\n<img src=x>' };
    expect(parseControllerMessage(encodeControllerMessage(message).trimEnd())).toEqual(message);
  });
});
