// Cross-platform terminal keymap model (§7.7): a profile maps each logical action to one or more
// chords; the renderer resolves a DOM key event to an action id and dispatches it. This module is
// pure and OS-agnostic — platform/profile selection and the side effects (clipboard, byte injection)
// live at the call site. The chord set IS the contract: `interrupt` is intentionally ABSENT, so
// Ctrl+C is bound to nothing, matchChord returns null, and the key passes through to the PTY as SIGINT.

/** Logical, rebindable actions — terminal editing/clipboard plus the §24.1C app navigation. No
 *  `interrupt`: see the module note on Ctrl+C. App actions (`toggleDrawer`, `view*`) are handled by
 *  the shell, not the terminal dispatch, so they pass through xterm untouched. */
export type KeyActionId =
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'newlineNoSubmit'
  | 'wordBack'
  | 'wordForward'
  | 'deleteWordBack'
  | 'deleteLine'
  | 'toggleDrawer'
  | 'viewTerminal'
  | 'viewArtifacts'
  | 'openSettings';

/** A normalized chord: a `key` (lower-cased letter, or a DOM key name like `Enter`/`ArrowLeft`/
 *  `Backspace`) plus the modifiers that must be held. An omitted modifier means "must NOT be held". */
export interface Chord {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

export type Keymap = Record<KeyActionId, Chord[]>;

/** Every action id, in display order — the rebinding UI iterates this. */
export const KEY_ACTION_IDS: KeyActionId[] = [
  'copy',
  'paste',
  'selectAll',
  'newlineNoSubmit',
  'wordBack',
  'wordForward',
  'deleteWordBack',
  'deleteLine',
  'toggleDrawer',
  'viewTerminal',
  'viewArtifacts',
  'openSettings',
];

/** The app-navigation actions the shell owns (§24.1C) — the terminal dispatch ignores these. */
export const APP_ACTION_IDS: readonly KeyActionId[] = [
  'toggleDrawer',
  'viewTerminal',
  'viewArtifacts',
  'openSettings',
];

export type KeymapProfile = 'mac' | 'pc';

/** The subset of a DOM KeyboardEvent matchChord needs (so it stays unit-testable, no DOM). */
export interface KeyEventLike {
  type: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** Motion actions translate to the exact byte sequences readline / Claude Code expect (§7.5.2). The
 *  bytes ARE the contract. Clipboard actions (copy/paste/selectAll) are side effects, not bytes, so
 *  they are absent here. */
export const BYTES_FOR: Partial<Record<KeyActionId, string>> = {
  newlineNoSubmit: '\x1b\r', // Meta+Enter "insert newline" form (no kitty-keyboard in xterm 5.5)
  wordBack: '\x1bb', // readline backward-word
  wordForward: '\x1bf', // readline forward-word
  deleteWordBack: '\x1b\x7f', // readline backward-kill-word
  deleteLine: '\x15', // readline backward-kill-line (Ctrl+U)
};

// Editing motions are identical across profiles (they key off Option/Alt, which DOM reports the same
// on every OS); only copy/paste/select-all differ — Cmd on macOS vs Ctrl+Shift on PC.
const MOTIONS: Pick<Keymap, 'newlineNoSubmit' | 'wordBack' | 'wordForward' | 'deleteWordBack'> = {
  newlineNoSubmit: [
    { key: 'Enter', shift: true },
    { key: 'Enter', alt: true },
  ],
  wordBack: [{ key: 'ArrowLeft', alt: true }],
  wordForward: [{ key: 'ArrowRight', alt: true }],
  deleteWordBack: [{ key: 'Backspace', alt: true }],
};

export const MAC_DEFAULTS: Keymap = {
  copy: [{ key: 'c', meta: true }],
  paste: [{ key: 'v', meta: true }],
  selectAll: [{ key: 'a', meta: true }],
  deleteLine: [{ key: 'Backspace', meta: true }], // Cmd+Backspace = delete to line start (macOS)
  toggleDrawer: [{ key: '9', meta: true }],
  viewTerminal: [{ key: '1', meta: true }],
  viewArtifacts: [{ key: '2', meta: true }],
  openSettings: [{ key: '0', meta: true }],
  ...MOTIONS,
};

export const PC_DEFAULTS: Keymap = {
  copy: [{ key: 'c', ctrl: true, shift: true }],
  paste: [{ key: 'v', ctrl: true, shift: true }],
  selectAll: [{ key: 'a', ctrl: true, shift: true }],
  deleteLine: [], // no portable PC chord — users press Ctrl+U directly
  // Ctrl+digit throughout — a digit never collides with a readline chord, so bare Ctrl+K stays kill-line.
  toggleDrawer: [{ key: '9', ctrl: true }],
  viewTerminal: [{ key: '1', ctrl: true }],
  viewArtifacts: [{ key: '2', ctrl: true }],
  openSettings: [{ key: '0', ctrl: true }],
  ...MOTIONS,
};

const PROFILES: Record<KeymapProfile, Keymap> = { mac: MAC_DEFAULTS, pc: PC_DEFAULTS };

/** A single-character key is matched case-insensitively (Shift uppercases `event.key`); named keys
 *  (`Enter`, `ArrowLeft`, …) are compared verbatim. */
function normKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function chordMatches(e: KeyEventLike, c: Chord): boolean {
  return (
    normKey(e.key) === normKey(c.key) &&
    e.ctrlKey === (c.ctrl ?? false) &&
    e.altKey === (c.alt ?? false) &&
    e.shiftKey === (c.shift ?? false) &&
    e.metaKey === (c.meta ?? false)
  );
}

/** Resolve a key event to the action it triggers, or null to let it pass through (Ctrl+C → SIGINT,
 *  plain Enter → submit, any unbound chord → the terminal's own handling). Only keydown is matched. */
export function matchChord(e: KeyEventLike, keymap: Keymap): KeyActionId | null {
  if (e.type !== 'keydown') return null;
  for (const action of Object.keys(keymap) as KeyActionId[]) {
    if (keymap[action].some((c) => chordMatches(e, c))) return action;
  }
  return null;
}

/** Capture a key event as a Chord for rebinding (§7.7): the held modifiers plus the normalized key.
 *  Callers must filter modifier-only presses (key === 'Control'/'Shift'/'Alt'/'Meta') first. */
export function eventToChord(e: KeyEventLike): Chord {
  const chord: Chord = { key: normKey(e.key) };
  if (e.ctrlKey) chord.ctrl = true;
  if (e.altKey) chord.alt = true;
  if (e.shiftKey) chord.shift = true;
  if (e.metaKey) chord.meta = true;
  return chord;
}

/** Two chords are equal when their normalized key and all four modifier flags match (an omitted
 *  modifier means "not held"). Distinct from chordMatches, which compares a chord to a live event. */
function chordsEqual(a: Chord, b: Chord): boolean {
  return (
    normKey(a.key) === normKey(b.key) &&
    (a.ctrl ?? false) === (b.ctrl ?? false) &&
    (a.alt ?? false) === (b.alt ?? false) &&
    (a.shift ?? false) === (b.shift ?? false) &&
    (a.meta ?? false) === (b.meta ?? false)
  );
}

/** The action currently bound to `chord` in `keymap`, or null if none holds it (§7.7 conflict
 *  detection). `except` skips one action, so re-recording an action's own chord is not a conflict. */
export function findChordOwner(keymap: Keymap, chord: Chord, except?: KeyActionId): KeyActionId | null {
  for (const action of Object.keys(keymap) as KeyActionId[]) {
    if (action === except) continue;
    if (keymap[action].some((c) => chordsEqual(c, chord))) return action;
  }
  return null;
}

const MAC_MODS = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' } as const;
const PC_MODS = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win' } as const;
const KEY_GLYPHS: Record<string, string> = {
  Enter: '⏎', Backspace: '⌫', Delete: '⌦', Escape: 'Esc', Tab: 'Tab', ' ': 'Space',
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
};

/** Render a chord as an ordered list of keycap labels for the settings UI (§7.7). `mac` chooses the
 *  glyph set: macOS modifier symbols in ⌃⌥⇧⌘ order, else spelled-out PC modifier names. Named keys
 *  map to glyphs (Enter→⏎, Backspace→⌫, arrows); single characters are upper-cased. */
export function chordToCaps(chord: Chord, mac: boolean): string[] {
  const mods = mac ? MAC_MODS : PC_MODS;
  const caps: string[] = [];
  if (chord.ctrl) caps.push(mods.ctrl);
  if (chord.alt) caps.push(mods.alt);
  if (chord.shift) caps.push(mods.shift);
  if (chord.meta) caps.push(mods.meta);
  caps.push(KEY_GLYPHS[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
  return caps;
}

/** The effective keymap: per-action user overrides merged over a base profile (§7.7). An override
 *  REPLACES that action's chords entirely (e.g. `copy: []` unbinds copy). */
export function resolveKeymap(base: KeymapProfile, overrides: Partial<Record<KeyActionId, Chord[]>> = {}): Keymap {
  const resolved = {} as Keymap;
  for (const action of Object.keys(PROFILES[base]) as KeyActionId[]) {
    resolved[action] = overrides[action] ?? PROFILES[base][action];
  }
  return resolved;
}
