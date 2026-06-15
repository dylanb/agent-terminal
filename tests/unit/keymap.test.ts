import { describe, expect, it, vi } from 'vitest';
import { keyEventToBytes, handleTerminalKey, type KeyEventLike } from '../../src/renderer/src/keymap';

// Agent key bindings (§7.5.2): map editor-style chords to the exact byte sequences
// Claude Code / readline expect. These bytes ARE the contract, so we assert them literally.
function ev(over: Partial<KeyEventLike>): KeyEventLike {
  return {
    type: 'keydown',
    key: 'a',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...over,
  };
}

describe('keyEventToBytes (§7.5.2 agent key bindings)', () => {
  it('Shift+Enter sends ESC+CR (insert newline, do not submit)', () => {
    expect(keyEventToBytes(ev({ key: 'Enter', shiftKey: true }))).toBe('\x1b\r');
  });

  it('Alt+Enter also sends ESC+CR (Meta+Enter newline convention)', () => {
    expect(keyEventToBytes(ev({ key: 'Enter', altKey: true }))).toBe('\x1b\r');
  });

  it('plain Enter is passed through (null) so xterm sends bare CR to submit', () => {
    expect(keyEventToBytes(ev({ key: 'Enter' }))).toBeNull();
  });

  it('Alt+Left sends meta-b (backward-word)', () => {
    expect(keyEventToBytes(ev({ key: 'ArrowLeft', altKey: true }))).toBe('\x1bb');
  });

  it('Alt+Right sends meta-f (forward-word)', () => {
    expect(keyEventToBytes(ev({ key: 'ArrowRight', altKey: true }))).toBe('\x1bf');
  });

  it('Alt+Backspace sends ESC+DEL (backward-kill-word)', () => {
    expect(keyEventToBytes(ev({ key: 'Backspace', altKey: true }))).toBe('\x1b\x7f');
  });

  it('plain Left/Right/Backspace are passed through (null)', () => {
    expect(keyEventToBytes(ev({ key: 'ArrowLeft' }))).toBeNull();
    expect(keyEventToBytes(ev({ key: 'ArrowRight' }))).toBeNull();
    expect(keyEventToBytes(ev({ key: 'Backspace' }))).toBeNull();
  });

  it('does not hijack chords that also hold Ctrl or Meta', () => {
    expect(keyEventToBytes(ev({ key: 'ArrowLeft', altKey: true, ctrlKey: true }))).toBeNull();
    expect(keyEventToBytes(ev({ key: 'Backspace', altKey: true, metaKey: true }))).toBeNull();
    expect(keyEventToBytes(ev({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBeNull();
  });

  it('only fires on keydown, never on keyup (avoids double-send)', () => {
    expect(keyEventToBytes(ev({ type: 'keyup', key: 'Enter', shiftKey: true }))).toBeNull();
    expect(keyEventToBytes(ev({ type: 'keyup', key: 'Backspace', altKey: true }))).toBeNull();
  });

  it('passes ordinary typing through untouched', () => {
    expect(keyEventToBytes(ev({ key: 'a' }))).toBeNull();
    expect(keyEventToBytes(ev({ key: 'b', altKey: true, shiftKey: true }))).toBeNull();
  });
});

describe('handleTerminalKey (§7.5.2 — send + suppress xterm default)', () => {
  it('sends the mapped bytes, suppresses the default, and prevents the browser default', () => {
    const send = vi.fn();
    const preventDefault = vi.fn();
    const e = { ...ev({ key: 'Backspace', altKey: true }), preventDefault } as unknown as KeyEventLike;

    const keep = handleTerminalKey(e, send);

    expect(send).toHaveBeenCalledWith('\x1b\x7f');
    expect(keep).toBe(false); // xterm must NOT also process the key
    expect(preventDefault).toHaveBeenCalled();
  });

  it('leaves unmapped keys to xterm and sends nothing', () => {
    const send = vi.fn();
    const keep = handleTerminalKey(ev({ key: 'a' }), send);

    expect(send).not.toHaveBeenCalled();
    expect(keep).toBe(true);
  });
});
