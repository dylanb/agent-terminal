import { describe, expect, it } from 'vitest';
import { encodeControllerMessage, parseControllerMessage, CONTROLLER_IDENTITY_MINOR, CONTROLLER_LOOP_MESSAGE_MINOR, CONTROLLER_PROTOCOL_MINOR, CONTROLLER_MAX_MESSAGE_BYTES } from '../../src/shared/controllerProtocol';

const registration = { version: 2, minor: 0, type: 'register', launchDirectory: '/tmp/project', repositoryRoot: null } as const;

describe('controller wire protocol', () => {
  it('accepts the explicit registration confirmation shared by controller and terminal', () => {
    const confirmation = { version: 2, minor: 0, type: 'registered' };
    let parsed: unknown;
    try { parsed = parseControllerMessage(JSON.stringify(confirmation)); } catch { parsed = null; }
    expect(parsed).toEqual(confirmation);
  });

  it.each([
    registration,
    { version: 2, type: 'activate', requestId: 'request-a' },
    { version: 2, type: 'result', requestId: 'request-a', outcome: 'activated' },
    { version: 2, type: 'result', requestId: 'request-a', outcome: 'unavailable' },
    { version: 2, type: 'dismiss-loop-message', id: 'message-a' },
  ] as const)('round trips $type messages', message => {
    expect(parseControllerMessage(encodeControllerMessage(message).trimEnd())).toEqual(message);
  });

  it.each([
    { ...registration, version: 3 },
    { ...registration, type: 'instruction', command: 'echo unsafe' },
    { ...registration, launchDirectory: '../relative' },
    { ...registration, repositoryRoot: 42 },
    { ...registration, minor: -1 },
    { ...registration, minor: 1.5 },
    { ...registration, minor: '2' },
    { version: 2, type: 'activate', requestId: '' },
    { version: 2, type: 'result', requestId: 'request-a', outcome: 'queued' },
    { version: 2, type: 'dismiss-loop-message', id: '' },
    { version: 2, type: 'dismiss-loop-message', id: 7 },
    { version: 2, type: 'dismiss-loop-message' },
    null,
    [],
  ])('rejects incompatible or malformed peer input %#', value => {
    expect(() => parseControllerMessage(JSON.stringify(value))).toThrow();
  });

  it('accepts a newer minor version within major 2 and drops the fields it does not know', () => {
    const newer = { ...registration, minor: 4, command: 'echo unsafe', colour: 'teal' };
    expect(parseControllerMessage(JSON.stringify(newer))).toEqual({ ...registration, minor: 4 });
  });

  it('drops unknown fields from activation traffic', () => {
    expect(parseControllerMessage(JSON.stringify({ version: 2, type: 'activate', requestId: 'request-a', pid: 1234 })))
      .toEqual({ version: 2, type: 'activate', requestId: 'request-a' });
  });

  it('reads an absent minor version as 0', () => {
    expect(parseControllerMessage('{"version":2,"type":"register","launchDirectory":"/tmp/project","repositoryRoot":null}'))
      .toEqual(registration);
  });

  it('writes minor version 0 handshakes without the optional minor field', () => {
    expect(encodeControllerMessage({ version: 2, minor: 0, type: 'registered' })).toBe('{"version":2,"type":"registered"}');
    expect(encodeControllerMessage(registration))
      .toBe('{"version":2,"type":"register","launchDirectory":"/tmp/project","repositoryRoot":null}');
  });

  it('writes a non-zero minor version', () => {
    expect(parseControllerMessage(encodeControllerMessage({ version: 2, minor: 3, type: 'registered' }).trimEnd()))
      .toEqual({ version: 2, minor: 3, type: 'registered' });
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

  it('keeps hostile-looking directory labels as literal data', () => {
    const message = { ...registration, launchDirectory: '/tmp/$(echo unsafe)\n<img src=x>' };
    expect(parseControllerMessage(encodeControllerMessage(message).trimEnd())).toEqual(message);
  });

  it('names minor 3 as the first whose peers carry title and branch, and speaks it', () => {
    expect({ identity: CONTROLLER_IDENTITY_MINOR, speaks: CONTROLLER_PROTOCOL_MINOR, afterLoopMessages: CONTROLLER_IDENTITY_MINOR > CONTROLLER_LOOP_MESSAGE_MINOR })
      .toEqual({ identity: 3, speaks: 3, afterLoopMessages: true });
  });
});
