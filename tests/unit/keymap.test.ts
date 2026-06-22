import { describe, expect, it, vi } from 'vitest';
import { handleTerminalKey, type KeyActions } from '../../src/renderer/src/keymap';
import { MAC_DEFAULTS, PC_DEFAULTS, type KeyEventLike } from '../../src/shared/keymap';

// The renderer's xterm key dispatch (§7.7): resolve the event against the active keymap and run the
// action — send bytes for motions (the bytes ARE the contract), or invoke a clipboard side effect.
// null/unbound passes through (Ctrl+C → SIGINT, plain Enter → submit).
function ev(over: Partial<KeyEventLike>): KeyEventLike & { preventDefault?: () => void } {
  return { type: 'keydown', key: 'a', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...over };
}

function actions(over: Partial<KeyActions> = {}): KeyActions {
  return { send: vi.fn(), copy: vi.fn(), paste: vi.fn(), selectAll: vi.fn(), ...over };
}

describe('handleTerminalKey — keymap-driven dispatch (§7.7)', () => {
  it('copies the selection on the copy chord, suppresses the key, prevents the browser default', () => {
    const a = actions();
    const preventDefault = vi.fn();
    const keep = handleTerminalKey({ ...ev({ key: 'c', metaKey: true }), preventDefault }, MAC_DEFAULTS, a);
    expect(a.copy).toHaveBeenCalled();
    expect(a.send).not.toHaveBeenCalled();
    expect(keep).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
  });

  it('passes Ctrl+C through to the PTY as SIGINT — never intercepted as copy', () => {
    const a = actions();
    expect(handleTerminalKey(ev({ key: 'c', ctrlKey: true }), MAC_DEFAULTS, a)).toBe(true);
    expect(handleTerminalKey(ev({ key: 'c', ctrlKey: true }), PC_DEFAULTS, a)).toBe(true);
    expect(a.copy).not.toHaveBeenCalled();
    expect(a.send).not.toHaveBeenCalled();
  });

  it('sends the byte sequence for a motion chord (Alt+Backspace → ESC+DEL)', () => {
    const a = actions();
    expect(handleTerminalKey(ev({ key: 'Backspace', altKey: true }), MAC_DEFAULTS, a)).toBe(false);
    expect(a.send).toHaveBeenCalledWith('\x1b\x7f');
  });

  it('sends the kill-to-line-start byte for the delete-line chord (Cmd+Backspace → Ctrl+U)', () => {
    const a = actions();
    expect(handleTerminalKey(ev({ key: 'Backspace', metaKey: true }), MAC_DEFAULTS, a)).toBe(false);
    expect(a.send).toHaveBeenCalledWith('\x15');
  });

  it('inserts a newline without submitting on Shift+Enter and Alt+Enter', () => {
    const a = actions();
    handleTerminalKey(ev({ key: 'Enter', shiftKey: true }), PC_DEFAULTS, a);
    handleTerminalKey(ev({ key: 'Enter', altKey: true }), PC_DEFAULTS, a);
    expect(a.send).toHaveBeenNthCalledWith(1, '\x1b\r');
    expect(a.send).toHaveBeenNthCalledWith(2, '\x1b\r');
  });

  it('passes plain Enter through so xterm submits with a bare CR', () => {
    const a = actions();
    expect(handleTerminalKey(ev({ key: 'Enter' }), PC_DEFAULTS, a)).toBe(true);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('passes ordinary typing through untouched', () => {
    const a = actions();
    expect(handleTerminalKey(ev({ key: 'a' }), MAC_DEFAULTS, a)).toBe(true);
    expect(a.send).not.toHaveBeenCalled();
  });

  it('pastes on the paste chord when the handler is wired, suppressing the key', () => {
    const a = actions();
    const keep = handleTerminalKey(ev({ key: 'v', metaKey: true }), MAC_DEFAULTS, a);
    expect(a.paste).toHaveBeenCalled();
    expect(keep).toBe(false);
  });

  it('selects all on the select-all chord when the handler is wired', () => {
    const a = actions();
    const keep = handleTerminalKey(ev({ key: 'a', metaKey: true }), MAC_DEFAULTS, a);
    expect(a.selectAll).toHaveBeenCalled();
    expect(keep).toBe(false);
  });

  it('passes a resolved action through unhandled when its handler is not wired', () => {
    const a: KeyActions = { send: vi.fn(), copy: vi.fn() }; // paste/selectAll not provided
    expect(handleTerminalKey(ev({ key: 'v', metaKey: true }), MAC_DEFAULTS, a)).toBe(true);
  });
});
