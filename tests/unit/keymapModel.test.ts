import { describe, it, expect } from 'vitest';
import {
  MAC_DEFAULTS,
  PC_DEFAULTS,
  KEY_ACTION_IDS,
  APP_ACTION_IDS,
  matchChord,
  resolveKeymap,
  eventToChord,
  findChordOwner,
  chordToCaps,
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
    // ⌘3/Ctrl+3 is no longer bound — the Todos view was removed, so the chord passes through.
    expect(matchChord(keydown({ key: '3', ctrlKey: true }), PC_DEFAULTS)).toBeNull();
  });
});

describe('keymap model — open settings action (§7.7)', () => {
  it('binds Cmd+, on macOS and Ctrl+, on PC, and is a shell-owned app action', () => {
    expect(matchChord(keydown({ key: ',', metaKey: true }), MAC_DEFAULTS)).toBe('openSettings');
    expect(matchChord(keydown({ key: ',', ctrlKey: true }), PC_DEFAULTS)).toBe('openSettings');
    expect(APP_ACTION_IDS).toContain('openSettings');
    expect(KEY_ACTION_IDS).toContain('openSettings');
  });
});

describe('keymap model — delete-line action (§7.7)', () => {
  it('binds Cmd+Backspace to deleteLine on macOS and leaves it unbound on PC', () => {
    expect(matchChord(keydown({ key: 'Backspace', metaKey: true }), MAC_DEFAULTS)).toBe('deleteLine');
    expect(resolveKeymap('pc').deleteLine).toEqual([]); // no portable PC chord — users press Ctrl+U
    expect(matchChord(keydown({ key: 'Backspace', metaKey: true }), PC_DEFAULTS)).toBeNull();
  });
});

describe('keymap model — findChordOwner (§7.7 conflict detection)', () => {
  it('returns the action a chord is already bound to', () => {
    expect(findChordOwner(MAC_DEFAULTS, { key: 'c', meta: true })).toBe('copy');
  });

  it('returns null when no action holds the chord', () => {
    expect(findChordOwner(MAC_DEFAULTS, { key: 'q', meta: true, shift: true })).toBeNull();
  });

  it('excludes the action being rebound, so re-recording its own chord is not a conflict', () => {
    expect(findChordOwner(MAC_DEFAULTS, { key: 'c', meta: true }, 'copy')).toBeNull();
  });

  it('treats an omitted modifier as "must not be held" (Meta+C is not Meta+Shift+C)', () => {
    expect(findChordOwner(MAC_DEFAULTS, { key: 'c', meta: true, shift: true })).toBeNull();
  });
});

describe('keymap model — chordToCaps (§7.7 keycap rendering)', () => {
  it('renders mac modifier glyphs in ⌃⌥⇧⌘ order plus the uppercased key', () => {
    expect(chordToCaps({ key: 'c', meta: true }, true)).toEqual(['⌘', 'C']);
    expect(chordToCaps({ key: 'a', ctrl: true, alt: true, shift: true, meta: true }, true)).toEqual(['⌃', '⌥', '⇧', '⌘', 'A']);
  });

  it('renders PC modifier words when not mac', () => {
    expect(chordToCaps({ key: 'c', ctrl: true, shift: true }, false)).toEqual(['Ctrl', 'Shift', 'C']);
  });

  it('maps named keys to glyphs (Enter/Backspace/arrows/space)', () => {
    expect(chordToCaps({ key: 'Enter', shift: true }, true)).toEqual(['⇧', '⏎']);
    expect(chordToCaps({ key: 'Backspace', alt: true }, true)).toEqual(['⌥', '⌫']);
    expect(chordToCaps({ key: 'ArrowLeft', alt: true }, true)).toEqual(['⌥', '←']);
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
