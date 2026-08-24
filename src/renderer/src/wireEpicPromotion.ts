import type { ConfirmDialogOptions } from './confirmDialog';

// §28.7 — mirrors wireAppBootstrapConflict: on the confirm-first preview, name every GitHub mutation the single
// confirm authorizes as discrete items (WCAG 1.3.1 — never a bare count before an irreversible outward action),
// then resolve against the exact repo + step the preview named (§6).

export interface EpicPromotionPreview {
  repoKey: string;
  step: string;
  epic: number;
  pr: number | null;
  subTickets: { index: number; title: string }[];
}

export interface EpicPromotionDeps {
  onPreview(cb: (preview: EpicPromotionPreview) => void): () => void;
  confirm(opts: ConfirmDialogOptions): void;
  resolve(repoKey: string, step: string, confirm: boolean): void;
}

export function wireEpicPromotion(deps: EpicPromotionDeps): () => void {
  return deps.onPreview(({ repoKey, step, epic, pr, subTickets }) => {
    const n = subTickets.length;
    const plural = n === 1 ? '' : 's';
    const resources = [
      ...subTickets.map((t) => `Create sub-ticket: ${t.title}`),
      `Add tracking checklist to epic #${epic}`,
      ...(pr !== null ? [`Close epic planning PR #${pr}`] : []),
    ];
    deps.confirm({
      title: `Create ${n} sub-ticket${plural}?`,
      message: `This creates ${n} sub-ticket${plural} on GitHub, adds a tracking checklist to the epic${pr !== null ? ', and closes the epic planning PR' : ''}. It cannot be undone.`,
      resources,
      confirmLabel: 'Create sub-tickets',
      role: 'alertdialog',
      onConfirm: () => deps.resolve(repoKey, step, true),
      onCancel: () => deps.resolve(repoKey, step, false),
    });
  });
}
