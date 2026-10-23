import { describe, expect, it } from 'vitest';
import { createControllerDecoder, encodeControllerMessage, parseControllerMessage, CONTROLLER_MAX_MESSAGE_BYTES } from '../../src/shared/controllerProtocol';

const registration = { version: 1, minor: 0, type: 'register', launchDirectory: '/tmp/project', repositoryRoot: null } as const;

describe('controller wire protocol', () => {
  it('accepts the explicit registration confirmation shared by controller and terminal', () => {
    const confirmation = { version: 1, minor: 0, type: 'registered' };
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
    { ...registration, minor: -1 },
    { ...registration, minor: 1.5 },
    { ...registration, minor: '2' },
    { version: 1, type: 'activate', requestId: '' },
    { version: 1, type: 'result', requestId: 'request-a', outcome: 'queued' },
    null,
    [],
  ])('rejects incompatible or malformed peer input %#', value => {
    expect(() => parseControllerMessage(JSON.stringify(value))).toThrow();
  });

  it('accepts a newer minor version within major 1 and drops the fields it does not know', () => {
    const newer = { ...registration, minor: 4, command: 'echo unsafe', colour: 'teal' };
    expect(parseControllerMessage(JSON.stringify(newer))).toEqual({ ...registration, minor: 4 });
  });

  it('drops unknown fields from activation traffic', () => {
    expect(parseControllerMessage(JSON.stringify({ version: 1, type: 'activate', requestId: 'request-a', pid: 1234 })))
      .toEqual({ version: 1, type: 'activate', requestId: 'request-a' });
  });

  it('reads an absent minor version as 0', () => {
    expect(parseControllerMessage('{"version":1,"type":"register","launchDirectory":"/tmp/project","repositoryRoot":null}'))
      .toEqual(registration);
  });

  // Protocol 1.0 is the shape builds without minor versions accept; anything else is rejected by them.
  it('writes minor version 0 handshakes in the exact protocol 1.0 shape', () => {
    expect(encodeControllerMessage({ version: 1, minor: 0, type: 'registered' })).toBe('{"version":1,"type":"registered"}\n');
    expect(encodeControllerMessage(registration))
      .toBe('{"version":1,"type":"register","launchDirectory":"/tmp/project","repositoryRoot":null}\n');
  });

  it('writes a non-zero minor version', () => {
    expect(parseControllerMessage(encodeControllerMessage({ version: 1, minor: 3, type: 'registered' }).trimEnd()))
      .toEqual({ version: 1, minor: 3, type: 'registered' });
  });

  // §23.6: every major version reads this one shape.
  it.each([
    '{"type":"incompatible","supported":{"min":1,"max":1}}',
    '{"version":7,"type":"incompatible","supported":{"min":2,"max":5},"reason":"future"}',
  ])('reads a version mismatch reply whatever major version sent it %#', frame => {
    expect(parseControllerMessage(frame)).toEqual({ type: 'incompatible', supported: JSON.parse(frame).supported });
  });

  it.each([
    { type: 'incompatible' },
    { type: 'incompatible', supported: { min: 2, max: 1 } },
    { type: 'incompatible', supported: { min: 1.5, max: 2 } },
    { type: 'incompatible', supported: { min: -1, max: 1 } },
  ])('rejects a malformed version mismatch reply %#', value => {
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
