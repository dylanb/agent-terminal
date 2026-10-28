export interface SwitchDeps {
  label: string;
  checked: boolean;
  onChange(checked: boolean): void;
}

export function createSwitch(host: HTMLElement, _deps: SwitchDeps): { set(checked: boolean): void; dispose(): void } {
  host.append(host.ownerDocument.createElement('span'));
  return { set() {}, dispose() {} };
}
