// Keyboard settings organism (§7.7 / UI-STANDARDS): a profile selector plus a per-action rebind list.
// `auto` follows the OS; `mac`/`pc` force the layout (e.g. a Mac keyboard on Linux). Each action row
// shows its current chord and a Record button that captures the next keypress as a new binding. Built
// from the host document so it stays relocatable; signals out only through the injected contract.

import { KEY_ACTION_IDS, eventToChord, type Chord, type KeyActionId, type Keymap } from '../../shared/keymap';
import type { KeymapProfileSetting } from '../../shared/ipc';

export interface KeyboardSettingsDeps {
  getProfile(): KeymapProfileSetting;
  onProfileChange(profile: KeymapProfileSetting): void;
  /** The active keymap, to display each action's current chord. */
  getKeymap(): Keymap;
  /** Persist a new binding for one action (§7.7). */
  onRebind(action: KeyActionId, chord: Chord): void;
}

export interface KeyboardSettings {
  /** Re-read profile + chords into the UI (e.g. after the persisted values hydrate async). */
  refresh(): void;
}

const PROFILE_OPTIONS: { value: KeymapProfileSetting; label: string }[] = [
  { value: 'auto', label: 'Auto (OS default)' },
  { value: 'mac', label: 'macOS-style (⌘C / ⌘V)' },
  { value: 'pc', label: 'PC-style (Ctrl+Shift+C / V)' },
];

const ACTION_LABELS: Record<KeyActionId, string> = {
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  newlineNoSubmit: 'Newline (no submit)',
  wordBack: 'Word left',
  wordForward: 'Word right',
  deleteWordBack: 'Delete word',
  deleteLine: 'Delete line',
  toggleDrawer: 'Toggle quick-send',
  viewTerminal: 'View: Terminal',
  viewArtifacts: 'View: Artifacts',
  viewTodos: 'View: Todos',
};

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

function formatChord(c: Chord): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Cmd');
  parts.push(c.key.length === 1 ? c.key.toUpperCase() : c.key);
  return parts.join('+');
}

function formatChords(chords: Chord[]): string {
  return chords.length > 0 ? chords.map(formatChord).join(' / ') : '—';
}

export function createKeyboardSettings(host: HTMLElement, deps: KeyboardSettingsDeps): KeyboardSettings {
  const doc = host.ownerDocument;

  const wrap = doc.createElement('label');
  wrap.className = 'kb-profile';
  const text = doc.createElement('span');
  text.className = 'mono';
  text.textContent = 'Keyboard';
  const select = doc.createElement('select');
  select.setAttribute('aria-label', 'Keyboard layout profile');
  for (const o of PROFILE_OPTIONS) {
    const opt = doc.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    select.appendChild(opt);
  }
  select.value = deps.getProfile();
  select.addEventListener('change', () => deps.onProfileChange(select.value as KeymapProfileSetting));
  wrap.append(text, select);

  const list = doc.createElement('div');
  list.className = 'kb-rebinds';

  // One in-flight capture at a time; the document-level keydown listener is removed as soon as a real
  // (non-modifier) key resolves the chord, so it never leaks into normal typing.
  let stopCapture: (() => void) | null = null;
  const endCapture = (): void => {
    stopCapture?.();
    stopCapture = null;
  };

  function startCapture(action: KeyActionId, btn: HTMLButtonElement): void {
    endCapture();
    btn.textContent = 'Press keys…';
    const onKey = (e: KeyboardEvent): void => {
      if (MODIFIER_KEYS.has(e.key)) return; // a modifier alone isn't a chord — wait for the real key
      e.preventDefault();
      endCapture();
      deps.onRebind(action, eventToChord(e));
      renderRows();
    };
    doc.addEventListener('keydown', onKey, true);
    stopCapture = () => doc.removeEventListener('keydown', onKey, true);
  }

  function renderRows(): void {
    endCapture();
    list.replaceChildren();
    const km = deps.getKeymap();
    for (const action of KEY_ACTION_IDS) {
      const row = doc.createElement('div');
      row.className = 'kb-row';
      row.dataset.action = action;

      const label = doc.createElement('span');
      label.className = 'kb-label';
      label.textContent = ACTION_LABELS[action];

      const chord = doc.createElement('kbd');
      chord.className = 'kb-chord';
      chord.textContent = formatChords(km[action]);

      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'linkbtn';
      btn.textContent = 'Record';
      btn.setAttribute('aria-label', `Record a new shortcut for ${ACTION_LABELS[action]}`);
      btn.addEventListener('click', () => startCapture(action, btn));

      row.append(label, chord, btn);
      list.appendChild(row);
    }
  }

  host.append(wrap, list);
  renderRows();

  return {
    refresh: () => {
      select.value = deps.getProfile();
      renderRows();
    },
  };
}
