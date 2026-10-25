import type { ControllerTerminal } from '../../shared/ipc';

export interface ControllerCardDeps {
  terminal: ControllerTerminal;
  fullReasons: ReadonlySet<string>;
  onReasonToggle(reason: string, full: boolean): void;
  onBringForward(): void;
  onDismiss(): void;
}

export interface ControllerCard {
  dispose(): void;
}

export function createControllerCard(host: HTMLElement, deps: ControllerCardDeps): ControllerCard {
  void host;
  void deps;
  return { dispose() {} };
}
