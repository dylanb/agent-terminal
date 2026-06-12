// App-owned selection model (§7.2–§7.3): first-class application state in absolute
// buffer coordinates, decoupled from browser focus. Text extracted at gesture time
// is the durable payload; coordinates are provenance only.

import type { BufferType, Cell } from '../../shared/ipc';

export interface SelectionState {
  active: boolean;
  start: Cell | null;
  end: Cell | null;
  text: string;
  baseY: number;
  bufferType: BufferType;
}

export interface SelectionGesture {
  range: { start: Cell; end: Cell } | undefined;
  text: string;
  baseY: number;
  bufferType: BufferType;
}

export interface SelectionModel {
  /** Applies a non-empty gesture; returns false for the blur-clears we ignore (§7.3). */
  update(gesture: SelectionGesture): boolean;
  clear(): void;
  get(): Readonly<SelectionState>;
}

export function createSelectionModel(onChange?: (state: SelectionState) => void): SelectionModel {
  const state: SelectionState = {
    active: false,
    start: null,
    end: null,
    text: '',
    baseY: 0,
    bufferType: 'normal',
  };

  return {
    update({ range, text, baseY, bufferType }) {
      if (!range || text.length === 0) return false;
      state.active = true;
      state.start = { ...range.start };
      state.end = { ...range.end };
      state.text = text;
      state.baseY = baseY;
      state.bufferType = bufferType;
      onChange?.(state);
      return true;
    },
    clear() {
      state.active = false;
      state.start = null;
      state.end = null;
      state.text = '';
      onChange?.(state);
    },
    get() {
      return state;
    },
  };
}

/** Trim per-line cell padding; drop one trailing newline so nothing auto-submits (§7.5). */
export function cleanSelectionText(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\r?\n$/, '');
}
