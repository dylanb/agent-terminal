import type { ControllerSortMode } from '../../shared/ipc';
import { createPressGroup, type GuardedPress } from './pressable';

export interface SortModeControlDeps {
  mode: ControllerSortMode;
  onChange(mode: ControllerSortMode): void | Promise<unknown>;
}

const OPTIONS: ReadonlyArray<readonly [ControllerSortMode, string]> = [['attention', 'Attention'], ['recently-used', 'Recently used']];
const STEPS: Readonly<Record<string, number>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function createSortModeControl(host: HTMLElement, deps: SortModeControlDeps): { dispose(): void } {
  const doc = host.ownerDocument;
  const group = doc.createElement('div');
  group.className = 'sort-mode-control';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Sort cards');
  const presses = createPressGroup();
  let selected = deps.mode;
  const options = OPTIONS.map(([mode, label]) => {
    const option = doc.createElement('button');
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.textContent = label;
    return { mode, option };
  });
  const show = () => {
    for (const { mode, option } of options) {
      option.setAttribute('aria-checked', String(mode === selected));
      option.tabIndex = mode === selected ? 0 : -1;
    }
  };
  const pressOf: GuardedPress[] = options.map(({ mode, option }) => presses.bind(option, () => {
    option.focus();
    selected = mode;
    show();
    return deps.onChange(mode);
  }));
  options.forEach(({ option }, index) => option.addEventListener('keydown', event => {
    const step = STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    pressOf[(index + step + options.length) % options.length]();
  }));
  show();
  group.append(...options.map(({ option }) => option));
  host.append(group);
  return { dispose() { group.remove(); } };
}
