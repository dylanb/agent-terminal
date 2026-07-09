import { describe, it, expect } from 'vitest';
import {
  isValidInstallExamplesPreview,
  isValidInstallExamplesApply,
} from '../../src/main/ipcValidation';
import { SESSION_ID } from '../../src/shared/ipc';

// Trust-boundary validation for the two new renderer→main channels (§6): only a live-session request
// with the right payload shape is accepted, so a stray/replayed message cannot drive a filesystem write.

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
  it('accepts a live-session request carrying a boolean overwrite flag', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, overwrite: true })).toBe(true);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, overwrite: false })).toBe(true);
  });
  it('rejects a wrong session', () => {
    expect(isValidInstallExamplesApply({ sessionId: 'other', overwrite: true })).toBe(false);
  });
  it('rejects a missing or non-boolean overwrite flag', () => {
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID })).toBe(false);
    expect(isValidInstallExamplesApply({ sessionId: SESSION_ID, overwrite: 'yes' })).toBe(false);
  });
});
