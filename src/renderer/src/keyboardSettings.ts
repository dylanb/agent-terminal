// Keyboard settings VIEW organism (§7.7 / UI-STANDARDS): a profile selector plus per-action rebind
// rows, grouped by category, with each chord drawn as keycaps. `auto` follows the OS; `mac`/`pc` force
// the layout. Clicking Set captures the next key combination as a new binding; a combination already
// bound elsewhere is BLOCKED (named, old binding kept). An overridden row offers Reset (restore the
// profile default). Built from the host document so it stays relocatable; signals out only through the
// injected contract.

import {
  chordToCaps,
  eventToChord,
  findChordOwner,
  type Chord,
  type KeyActionId,
  type Keymap,
} from '../../shared/keymap';
import type { KeymapProfileSetting } from '../../shared/ipc';
import { FOCUS_VIEW_EVENT } from './paneActions';

// This organism backs shell view 4 (§7.7); it focuses its primary control when the shell announces
// that view, mirroring terminal.ts/artifacts.ts (§22.4 / WCAG 2.4.3).
const SETTINGS_VIEW = '4';

// Spell named keys out for the chord's accessible name (WCAG 1.1.1) — the visible keycaps are glyphs.
const KEY_NAMES: Record<string, string> = {
  ArrowLeft: 'Left arrow', ArrowRight: 'Right arrow', ArrowUp: 'Up arrow', ArrowDown: 'Down arrow', ' ': 'Space',
};

export interface KeyboardSettingsDeps {
  getProfile(): KeymapProfileSetting;
  onProfileChange(profile: KeymapProfileSetting): void;
  /** The active resolved keymap — display chords + conflict detection. */
  getKeymap(): Keymap;
  /** Per-action overrides, to mark which rows differ from their profile default (§7.7). */
  getOverrides(): Partial<Record<KeyActionId, Chord[]>>;
  /** Whether to draw mac modifier glyphs (⌘⌥⇧⌃) vs spelled-out PC names. */
  isMac(): boolean;
  /** Persist a new binding for one action (§7.7). */
  onRebind(action: KeyActionId, chord: Chord): void;
  /** Drop one action's override, restoring its profile default. */
  onReset(action: KeyActionId): void;
}

export interface KeyboardSettings {
  /** Re-read profile + chords into the UI (e.g. after the persisted values hydrate async). */
  refresh(): void;
  dispose(): void;
}

const PROFILE_OPTIONS: { value: KeymapProfileSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'mac', label: 'macOS' },
  { value: 'pc', label: 'PC' },
];

const ACTION_LABELS: Record<KeyActionId, string> = {
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  newlineNoSubmit: 'Newline, no submit',
  wordBack: 'Word left',
  wordForward: 'Word right',
  deleteWordBack: 'Delete word',
  deleteLine: 'Delete line',
  toggleDrawer: 'Toggle quick-send',
  viewTerminal: 'View: Terminal',
  viewArtifacts: 'View: Artifacts',
  viewTodos: 'View: Todos',
  openSettings: 'Open settings',
};

const ACTION_DESCS: Record<KeyActionId, string> = {
  copy: 'Copy the selected text to the clipboard.',
  paste: 'Paste clipboard text into the terminal.',
  selectAll: 'Select everything in the terminal.',
  newlineNoSubmit: 'Add a line break without running the command.',
  wordBack: 'Move the cursor back one word.',
  wordForward: 'Move the cursor forward one word.',
  deleteWordBack: 'Delete the word before the cursor.',
  deleteLine: 'Delete to the start of the line.',
  toggleDrawer: 'Show or hide the quick-send drawer.',
  viewTerminal: 'Switch to the terminal.',
  viewArtifacts: 'Switch to the artifact viewer.',
  viewTodos: 'Switch to the todo list.',
  openSettings: 'Open this settings view.',
};

const GROUPS: { label: string; actions: KeyActionId[] }[] = [
  { label: 'Clipboard', actions: ['copy', 'paste', 'selectAll'] },
  { label: 'Editing', actions: ['newlineNoSubmit', 'wordBack', 'wordForward', 'deleteWordBack', 'deleteLine'] },
  { label: 'Navigation', actions: ['toggleDrawer', 'viewTerminal', 'viewArtifacts', 'viewTodos', 'openSettings'] },
];

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

export function createKeyboardSettings(host: HTMLElement, deps: KeyboardSettingsDeps): KeyboardSettings {
  const doc = host.ownerDocument;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // One in-flight capture at a time. `conflict` holds the message for a blocked combination so the row
  // can show it while the listener stays live (the user can try another combination or cancel).
  let capturing: KeyActionId | null = null;
  let conflict: string | null = null;
  let stopCapture: (() => void) | null = null;
  const endCapture = (): void => {
    stopCapture?.();
    stopCapture = null;
    capturing = null;
    conflict = null;
  };

  // Record on the window in the capture phase, NOT the document: a window-capture listener fires
  // ahead of any document-level capture listener (the shell's app-nav handler, §22.4), so an app-nav
  // chord pressed mid-recording is swallowed here and never also fires navigation behind the view.
  const captureTarget: EventTarget = doc.defaultView ?? doc;

  function startCapture(action: KeyActionId): void {
    endCapture();
    capturing = action;
    conflict = null;
    const onKey = (e: KeyboardEvent): void => {
      if (MODIFIER_KEYS.has(e.key)) return; // a modifier alone isn't a chord — wait for the real key
      // While recording, swallow every real key so it never leaks to the shell/terminal (e.g. '1'
      // must not switch views, Esc must not close a panel behind us).
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        endCapture();
        render();
        focusRowButton(action); // WCAG 2.4.3: the row rebuilt — keep focus on its control
        return;
      }
      const chord = eventToChord(e);
      const owner = findChordOwner(deps.getKeymap(), chord, action);
      if (owner) {
        conflict = `${chordToCaps(chord, deps.isMac()).join('')} already maps to ${ACTION_LABELS[owner]}`;
        render(); // stay live; old binding is kept
        focusRowButton(action);
        return;
      }
      endCapture();
      deps.onRebind(action, chord);
      render();
      focusRowButton(action);
    };
    captureTarget.addEventListener('keydown', onKey as EventListener, true);
    stopCapture = () => captureTarget.removeEventListener('keydown', onKey as EventListener, true);
    render();
  }

  /** Focus a row's Set/Cancel/Reset control after a render() rebuilt it, so keyboard focus never
   *  drops to <body> mid-task (WCAG 2.4.3). */
  function focusRowButton(action: KeyActionId): void {
    groupsHost.querySelector<HTMLButtonElement>(`[data-action="${action}"] .kr-ctl button`)?.focus();
  }

  /** A chord's spelled-out accessible name (WCAG 1.1.1): the visible keycaps are glyphs an SR can't
   *  reliably verbalize, so the chord cell carries this as its label. */
  function chordAria(chord: Chord): string {
    const parts: string[] = [];
    if (chord.ctrl) parts.push('Control');
    if (chord.alt) parts.push(deps.isMac() ? 'Option' : 'Alt');
    if (chord.shift) parts.push('Shift');
    if (chord.meta) parts.push(deps.isMac() ? 'Command' : 'Windows');
    parts.push(KEY_NAMES[chord.key] ?? (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key));
    return parts.join(' ');
  }

  // --- static chrome (header + profile) ---
  const viewRoot = el('div', 'kview');

  const head = el('div', 'kview-head');
  head.append(el('div', 'eyebrow', 'Settings'), el('h1', 'serif', 'Keyboard'));
  head.append(el('div', 'sub', 'Rebind any shortcut. Changes save as you make them; press Esc to cancel a recording.'));

  const profile = el('div', 'kprofile');
  const profileText = el('div');
  profileText.append(el('div', 'kp-label', 'Layout profile'), el('div', 'kp-help', 'Auto follows your operating system.'));
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Layout profile');
  const segButtons = PROFILE_OPTIONS.map((o) => {
    const b = el('button', 'seg-opt', o.label);
    b.type = 'button';
    b.addEventListener('click', () => deps.onProfileChange(o.value));
    seg.appendChild(b);
    return { value: o.value, btn: b };
  });
  profile.append(profileText, seg);

  // A persistent live region (WCAG 4.1.3): it lives OUTSIDE groupsHost so render()'s replaceChildren
  // never destroys it, and its text mutation (set in render()) announces recording start / a conflict.
  const liveRegion = el('div', 'kstatus-live');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'assertive');

  const groupsHost = el('div', 'kgroups');
  viewRoot.append(head, profile, liveRegion, groupsHost);
  host.appendChild(viewRoot);

  /** Focus the view's primary control (the active profile segment) — called when the shell announces
   *  this view, so opening Settings never strands focus on <body> (§22.4 / WCAG 2.4.3). */
  function focusPrimary(): void {
    (segButtons.find((s) => s.value === deps.getProfile())?.btn ?? segButtons[0].btn).focus();
  }
  const win = doc.defaultView;
  const onFocusView = (e: Event): void => {
    if ((e as CustomEvent<{ view?: string }>).detail?.view === SETTINGS_VIEW) focusPrimary();
  };
  win?.addEventListener(FOCUS_VIEW_EVENT, onFocusView);

  function syncProfile(): void {
    const active = deps.getProfile();
    for (const { value, btn } of segButtons) {
      const on = value === active;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  function renderRow(action: KeyActionId): HTMLElement {
    const km = deps.getKeymap();
    const overridden = deps.getOverrides()[action] !== undefined;
    const live = capturing === action;
    const row = el('div', live ? 'krow live' : overridden ? 'krow mod' : 'krow');
    row.dataset.action = action;

    const main = el('div');
    main.append(el('div', 'kr-name', ACTION_LABELS[action]), el('div', 'kr-desc', ACTION_DESCS[action]));

    const chordCell = el('div', 'kr-chord');
    if (capturing === action) {
      const cap = el('span', conflict ? 'kcapture bad' : 'kcapture', conflict ?? 'Press a shortcut…');
      chordCell.appendChild(cap);
    } else {
      const chords = km[action];
      if (chords.length === 0) {
        chordCell.appendChild(el('span', 'kr-unset', 'Not set'));
      } else {
        // The keycaps are decorative glyphs; the cell carries the spelled-out chord as its name (WCAG 1.1.1).
        chordCell.setAttribute('role', 'img');
        chordCell.setAttribute('aria-label', chordAria(chords[0]));
        for (const c of chordToCaps(chords[0], deps.isMac())) chordCell.appendChild(el('span', 'kc', c));
      }
    }

    const ctl = el('div', 'kr-ctl');
    const btn = el('button', 'linkbtn');
    btn.type = 'button';
    if (capturing === action) {
      btn.textContent = 'Cancel';
      btn.setAttribute('aria-label', `Cancel recording ${ACTION_LABELS[action]}`);
      btn.addEventListener('click', () => { endCapture(); render(); focusRowButton(action); });
    } else if (overridden) {
      btn.textContent = 'Reset';
      btn.setAttribute('aria-label', `Reset ${ACTION_LABELS[action]} to its default`);
      btn.addEventListener('click', () => { deps.onReset(action); focusRowButton(action); });
    } else {
      btn.textContent = 'Set';
      btn.setAttribute('aria-label', `Record a new shortcut for ${ACTION_LABELS[action]}`);
      btn.addEventListener('click', () => { startCapture(action); focusRowButton(action); });
    }
    ctl.appendChild(btn);

    row.append(main, chordCell, ctl);
    return row;
  }

  function render(): void {
    syncProfile();
    // Announce recording state via the persistent live region (WCAG 4.1.3); cleared when idle.
    liveRegion.textContent = capturing
      ? (conflict ?? `Recording ${ACTION_LABELS[capturing]}. Press a shortcut, or Escape to cancel.`)
      : '';
    groupsHost.replaceChildren();
    for (const group of GROUPS) {
      const section = el('section', 'kgroup');
      section.append(el('div', 'eyebrow', group.label));
      for (const action of group.actions) section.appendChild(renderRow(action));
      groupsHost.appendChild(section);
    }
  }

  render();

  return {
    refresh: render,
    dispose: () => {
      endCapture();
      win?.removeEventListener(FOCUS_VIEW_EVENT, onFocusView);
      host.replaceChildren();
    },
  };
}
