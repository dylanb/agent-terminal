import type { DestRelativePath, InstallExamplesPreview } from '../../src/shared/ipc';
import { allByRole, byRole } from './byRole';

export function installExamplesScreen(host: ParentNode) {
  return {
    button: (name: string) => byRole(host, 'button', name),
    checkbox: (name: string) => byRole(host, 'checkbox', name) as HTMLInputElement,
    heading: (name: string) => byRole(host, 'heading', name),
    status: (name: string) => byRole(host, 'status', name),
    alerts: (name: string) => allByRole(host, 'alert', name),
    groups: (name: string) => allByRole(host, 'group', name),
  };
}

export function reviewerInstallPreview(): Extract<InstallExamplesPreview, { ok: true }> {
  return {
    ok: true,
    previewId: 'reviewer-preview-7' as Extract<InstallExamplesPreview, { ok: true }>['previewId'],
    destinations: [
      { destination: 'agents', conflict: true, files: ['cedar.md'] as DestRelativePath[] },
      { destination: 'codexAgents', conflict: true, files: ['birch.toml', 'elm.toml'] as DestRelativePath[] },
    ],
    retired: [],
    retiredFallback: null,
    alwaysReplaced: [],
  };
}
