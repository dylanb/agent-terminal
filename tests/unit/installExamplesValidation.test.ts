import { describe, it, expect } from 'vitest';
import {
  isValidInstallExamplesPreview,
  isValidInstallExamplesApply,
} from '../../src/main/ipcValidation';
import { INSTALL_DESTINATION_IDS, SESSION_ID } from '../../src/shared/ipc';

// Trust-boundary validation for the two renderer→main channels (§6): only a live-session request with
// the right payload shape is accepted, so a stray/replayed message cannot drive a filesystem write. The
// apply payload now carries a per-destination replace list; an unknown destination id is rejected rather
// than silently ignored (CWE-20).

describe('isValidInstallExamplesPreview', () => {
  it('accepts a live-session request', () => {
    expect(isValidInstallExamplesPreview({ sessionId: SESSION_ID })).toBe(true);
  });
  it('rejects a wrong or missing session', () => {
    expect(isValidInstallExamplesPreview({ sessionId: 'other' })).toBe(false);
    expect(isValidInstallExamplesPreview({})).toBe(false);
    expect(isValidInstallExamplesPreview(null)).toBe(false);
  });
});

describe('isValidInstallExamplesApply', () => {
  it('accepts a live-session request whose replace list is empty', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: [] })).toBe(true);
  });

  it('accepts every known destination id, singly and together', () => {
    for (const id of INSTALL_DESTINATION_IDS) {
      expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: [id] })).toBe(true);
    }
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: [...INSTALL_DESTINATION_IDS] })).toBe(true);
  });

  it('rejects a wrong session', () => {
    expect(isValidInstallExamplesApply({ sessionId: 'other', replace: [] })).toBe(false);
  });

  it('rejects a missing replace list', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID })).toBe(false);
  });

  it('rejects a replace list that is not an array of destination ids', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: 'flow' })).toBe(false);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: true })).toBe(false);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: [1] })).toBe(false);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: [null] })).toBe(false);
  });

  it('rejects an unknown destination id rather than ignoring it', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: ['everything'] })).toBe(false);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, replace: ['flow', '../../etc'] })).toBe(false);
  });
});
