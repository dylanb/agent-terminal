import type { ControllerSortMode } from '../../shared/ipc';
import { onPress } from './pressable';

export interface SortModeControlDeps {
  mode: ControllerSortMode;
  onChange(mode: ControllerSortMode): void | Promise<unknown>;
}

const OPTIONS: ReadonlyArray<readonly [ControllerSortMode, string]> = [['attention', 'Attention'], ['recently-used', 'Recently used']];

export function createSortModeControl(host: HTMLElement, deps: SortModeControlDeps): { dispose(): void } {
  const doc = host.ownerDocument;
  const group = doc.createElement('div');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Sort cards');
  for (const [mode, label] of OPTIONS) {
    const option = doc.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', 'false');
    option.textContent = label;
    onPress(option, () => deps.onChange(mode));
    group.append(option);
  }
  host.append(group);
  return { dispose() {} };
}
