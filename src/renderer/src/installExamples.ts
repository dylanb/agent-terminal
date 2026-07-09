// Install-examples VIEW organism (§18.1/§23.4 / UI-STANDARDS): a single Install action that seeds the
// bundled feature-dev flow into the global flow home. Non-destructive — a read-only preview drives an
// up-front overwrite prompt (the blocking-dialog pattern, UI §5) only when a target exists and differs;
// otherwise it installs without prompting. Built from the host document so it stays relocatable; signals
// out only through the injected contract.

import type { InstallExamplesPreview, InstallExamplesResult } from '../../shared/ipc';

export interface InstallExamplesDeps {
  preview(): Promise<InstallExamplesPreview>;
  apply(overwrite: boolean): Promise<InstallExamplesResult>;
}

export interface InstallExamples {
  dispose(): void;
}

export function createInstallExamples(host: HTMLElement, deps: InstallExamplesDeps): InstallExamples {
  throw new Error('not implemented');
}
