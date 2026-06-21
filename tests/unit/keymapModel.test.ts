import { describe, it, expect } from 'vitest';
import {
  MAC_DEFAULTS,
  PC_DEFAULTS,
  KEY_ACTION_IDS,
  matchChord,
  resolveKeymap,
  eventToChord,
  type KeyEventLike,
} from '../../src/shared/keymap';

// The shared, OS-agnostic keymap model (§7.7): a profile maps each logical action to one or more
// chords; matchChord resolves a DOM key event to an action id (or null = passthrough). The chord set
// IS the contract — Ctrl+C is deliberately bound to NOTHING so it passes through to the PTY as SIGINT.
const keydown = (e: Partial<KeyEventLike>): KeyEventLike => ({
  type: 'keydown',
  key: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...e,
});

describe('keymap model — matchChord (§7.7)', () => {
  it('resolves the macOS copy chord (Meta+C) to copy', () => {
    expect(matchChord(keydown({ key: 'c', metaKey: true }), MAC_DEFAULTS)).toBe('copy');
  });

  it('resolves the PC copy chord (Ctrl+Shift+C) to copy', () => {
    expect(matchChord(keydown({ key: 'c', ctrlKey: true, shiftKey: true }), PC_DEFAULTS)).toBe('copy');
  });

  it('leaves Ctrl+C unbound in BOTH profiles so it passes through as SIGINT', () => {
    const ctrlC = keydown({ key: 'c', ctrlKey: true });
    expect(matchChord(ctrlC, MAC_DEFAULTS)).toBeNull();
    expect(matchChord(ctrlC, PC_DEFAULTS)).toBeNull();
  });

  it('does not resolve the PC copy chord under bare Ctrl+C (Shift is required)', () => {
    expect(matchChord(keydown({ key: 'c', ctrlKey: true }), PC_DEFAULTS)).toBeNull();
  });

  it('requires an exact modifier match (no extra modifiers held)', () => {
    // Meta+Shift+C is not the macOS copy chord (Meta+C) — extra Shift must not match.
    expect(matchChord(keydown({ key: 'c', metaKey: true, shiftKey: true }), MAC_DEFAULTS)).toBeNull();
  });

  it('ignores non-keydown events', () => {
    expect(matchChord({ ...keydown({ key: 'c', metaKey: true }), type: 'keyup' }, MAC_DEFAULTS)).toBeNull();
  });

  it('matches letter keys case-insensitively (Shift uppercases event.key)', () => {
    // PC copy holds Shift, so event.key arrives as 'C'; the chord stores 'c'.
    expect(matchChord(keydown({ key: 'C', ctrlKey: true, shiftKey: true }), PC_DEFAULTS)).toBe('copy');
  });
});

describe('keymap model — eventToChord (§7.7 rebinding capture)', () => {
  it('captures the held modifiers and normalizes the key', () => {
    expect(eventToChord(keydown({ key: 'K', ctrlKey: true, shiftKey: true }))).toEqual({ key: 'k', ctrl: true, shift: true });
  });

  it('omits modifiers that are not held', () => {
    expect(eventToChord(keydown({ key: 'v', metaKey: true }))).toEqual({ key: 'v', meta: true });
  });

  it('round-trips through matchChord as a single-action override', () => {
    const chord = eventToChord(keydown({ key: 'j', ctrlKey: true, altKey: true }));
    const km = resolveKeymap('pc', { copy: [chord] });
    expect(matchChord(keydown({ key: 'j', ctrlKey: true, altKey: true }), km)).toBe('copy');
  });

  it('exposes the full action id list for the rebinding UI', () => {
    expect(KEY_ACTION_IDS).toEqual(expect.arrayContaining(['copy', 'paste', 'selectAll']));
  });
});

describe('keymap model — app navigation actions (§7.7 / §24.1C)', () => {
  it('binds drawer + view switching per profile, keeping Ctrl+K free for readline on PC', () => {
    expect(matchChord(keydown({ key: 'k', metaKey: true }), MAC_DEFAULTS)).toBe('toggleDrawer');
    expect(matchChord(keydown({ key: 'k', ctrlKey: true, shiftKey: true }), PC_DEFAULTS)).toBe('toggleDrawer');
    // Bare Ctrl+K is NOT the drawer on PC — it passes through as readline kill-line.
    expect(matchChord(keydown({ key: 'k', ctrlKey: true }), PC_DEFAULTS)).toBeNull();
    expect(matchChord(keydown({ key: '1', ctrlKey: true }), PC_DEFAULTS)).toBe('viewTerminal');
    expect(matchChord(keydown({ key: '2', metaKey: true }), MAC_DEFAULTS)).toBe('viewArtifacts');
    expect(matchChord(keydown({ key: '3', ctrlKey: true }), PC_DEFAULTS)).toBe('viewTodos');
  });
});

describe('keymap model — resolveKeymap (§7.7)', () => {
  it('returns the mac base profile bindings', () => {
    expect(resolveKeymap('mac').copy).toContainEqual({ key: 'c', meta: true });
  });

  it('merges per-action overrides over the base profile', () => {
    const km = resolveKeymap('pc', { copy: [{ key: 'c', meta: true }] });
    expect(matchChord(keydown({ key: 'c', metaKey: true }), km)).toBe('copy'); // overridden
    expect(matchChord(keydown({ key: 'c', ctrlKey: true, shiftKey: true }), km)).toBeNull(); // base replaced
  });
});
