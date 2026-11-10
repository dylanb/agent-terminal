import { onPress } from './pressable';

export interface SwitchDeps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void | Promise<unknown>;
}

export interface Switch {
  set(checked: boolean): void;
  dispose(): void;
}

export function createSwitch(host: HTMLElement, deps: SwitchDeps): Switch {
  const doc = host.ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'switch';
  button.setAttribute('role', 'switch');
  const track = doc.createElement('span');
  track.className = 'switch-track';
  track.setAttribute('aria-hidden', 'true');
  const knob = doc.createElement('span');
  knob.className = 'switch-knob';
  track.append(knob);
  const label = doc.createElement('span');
  label.textContent = deps.label;
  button.append(track, label);
  let checked = deps.checked;
  const show = () => { button.setAttribute('aria-checked', String(checked)); };
  show();
  onPress(button, () => {
    checked = !checked;
    show();
    return deps.onChange(checked);
  });
  host.append(button);
  return {
    set(next) {
      checked = next;
      show();
    },
    dispose() { button.remove(); },
  };
}
