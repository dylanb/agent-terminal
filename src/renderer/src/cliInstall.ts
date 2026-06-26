// CLI launcher install VIEW organism (§23.4 / UI-STANDARDS): a single Install action that puts the
// agent-terminal command on PATH and announces success or a visible error.

import type { CliInstallResult } from '../../shared/ipc';

export interface CliInstallDeps {
  install(): Promise<CliInstallResult>;
}

export interface CliInstall {
  dispose(): void;
}

export function createCliInstall(_host: HTMLElement, _deps: CliInstallDeps): CliInstall {
  return { dispose: () => {} };
}
