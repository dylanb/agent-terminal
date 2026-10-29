import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROLLER_DEFAULT_ALWAYS_ON_TOP } from '../shared/ipc';
import { atomicWriteFileSync } from './atomicFile';
import { errMsg } from './errno';
import { isRecord } from './yamlRecord';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ControllerWindowState {
  /** `null` opens the window at the default size and placement. */
  bounds: WindowBounds | null;
  alwaysOnTop: boolean;
}

export interface ControllerWindowStateStore {
  load(): ControllerWindowState;
  saveBounds(bounds: WindowBounds): void;
  saveAlwaysOnTop(alwaysOnTop: boolean): void;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function windowBounds(value: unknown): WindowBounds | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && width > 0 && isFiniteNumber(height) && height > 0
    ? { x, y, width, height }
    : null;
}

export function createControllerWindowStateStore(userDataDir: string): ControllerWindowStateStore {
  const file = join(userDataDir, 'controller-window.json');
  function load(): ControllerWindowState {
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      saved = undefined;
    }
    const record = isRecord(saved) ? saved : {};
    return {
      bounds: windowBounds(record.bounds),
      alwaysOnTop: typeof record.alwaysOnTop === 'boolean' ? record.alwaysOnTop : CONTROLLER_DEFAULT_ALWAYS_ON_TOP,
    };
  }
  function save(change: Partial<ControllerWindowState>): void {
    try {
      if (!atomicWriteFileSync(file, JSON.stringify({ ...load(), ...change }))) console.error(`Controller window state not saved: ${userDataDir} is not a directory`);
    } catch (error) {
      console.error(`Controller window state not saved: ${errMsg(error)}`);
    }
  }
  return {
    load,
    saveBounds: bounds => save({ bounds }),
    saveAlwaysOnTop: alwaysOnTop => save({ alwaysOnTop }),
  };
}

const overlaps = (a: WindowBounds, b: WindowBounds): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export function placeWindow(saved: WindowBounds | null, workAreas: readonly WindowBounds[]): WindowBounds | null {
  return saved && workAreas.some(area => overlaps(saved, area)) ? saved : null;
}
