import type { SetupStatusReply } from '../../shared/ipc';

export interface SetupCheckDialogDeps {
  status(repoKey: string): Promise<SetupStatusReply>;
}

export interface SetupCheckDialog {
  check(repoKey: string): Promise<void>;
  dispose(): void;
}

export function createSetupCheckDialog(host: HTMLElement, deps: SetupCheckDialogDeps): SetupCheckDialog {
  const doc = host.ownerDocument;
  return {
    async check(repoKey) {
      await deps.status(repoKey).catch(() => null);
      const modal = doc.createElement('div');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      const title = doc.createElement('h3');
      title.id = `setup-check-title-${host.childElementCount}`;
      title.textContent = repoKey;
      modal.setAttribute('aria-labelledby', title.id);
      modal.append(title);
      host.replaceChildren(modal);
    },
    dispose() {},
  };
}
