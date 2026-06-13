import { describe, expect, it } from 'vitest';
import { SESSION_ID } from '../../src/shared/ipc';
import {
  isValidCapture,
  isValidCaptureCommand,
  isValidCommandsRequest,
  isValidInject,
  isValidInput,
  isValidResize,
} from '../../src/main/ipcValidation';

const sid = SESSION_ID;

describe('IPC payload validation (§6 — renderer-supplied input is untrusted)', () => {
  it('accepts a well-formed resize and rejects non-positive / non-integer / NaN sizes', () => {
    expect(isValidResize({ sessionId: sid, cols: 80, rows: 24 })).toBe(true);
    expect(isValidResize({ sessionId: sid, cols: 0, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: -5, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: 80.5, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: Number.NaN, rows: 24 })).toBe(false);
    expect(isValidResize({ sessionId: sid, cols: 80 })).toBe(false);
  });

  it('rejects payloads whose sessionId does not match the live session', () => {
    expect(isValidResize({ sessionId: 'other', cols: 80, rows: 24 })).toBe(false);
    expect(isValidInput({ sessionId: 'other', data: 'x' })).toBe(false);
  });

  it('accepts a string-data input and rejects non-string data', () => {
    expect(isValidInput({ sessionId: sid, data: 'ls\n' })).toBe(true);
    expect(isValidInput({ sessionId: sid, data: 123 })).toBe(false);
    expect(isValidInput(null)).toBe(false);
  });

  it('accepts a well-formed inject and rejects non-string text / non-boolean submit', () => {
    expect(isValidInject({ sessionId: sid, text: 'hi', submit: true })).toBe(true);
    expect(isValidInject({ sessionId: sid, text: 5, submit: true })).toBe(false);
    expect(isValidInject({ sessionId: sid, text: 'hi', submit: 'yes' })).toBe(false);
  });

  it('accepts a selection capture and rejects a wrong source or non-string text', () => {
    expect(isValidCapture({ sessionId: sid, text: 'x', range: null, source: 'selection' })).toBe(true);
    expect(isValidCapture({ sessionId: sid, text: 'x', range: null, source: 'other' })).toBe(false);
    expect(isValidCapture({ sessionId: sid, text: 7, range: null, source: 'selection' })).toBe(false);
  });

  it('accepts a well-formed commands request and rejects a wrong sessionId (§15.4)', () => {
    expect(isValidCommandsRequest({ sessionId: sid })).toBe(true);
    expect(isValidCommandsRequest({ sessionId: 'other' })).toBe(false);
    expect(isValidCommandsRequest(null)).toBe(false);
  });

  it('accepts a capture-command request and rejects missing/non-string commandId (§15.4)', () => {
    expect(isValidCaptureCommand({ sessionId: sid, commandId: 'abc' })).toBe(true);
    expect(isValidCaptureCommand({ sessionId: sid, commandId: 7 })).toBe(false);
    expect(isValidCaptureCommand({ sessionId: sid })).toBe(false);
    expect(isValidCaptureCommand({ sessionId: 'other', commandId: 'abc' })).toBe(false);
  });
});
