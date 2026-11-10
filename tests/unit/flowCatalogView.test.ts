// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { createInstallExamples, type InstallExamplesDeps } from '../../src/renderer/src/installExamples';
import type {
  DestRelativePath,
  InstallDestinationId,
  InstallExamplesPreview,
  InstallExamplesResult,
  InstallPreviewId,
} from '../../src/shared/ipc';

// A1 (#132) renderer half of the tracer bullet: when an install writes a flowCatalog group, the grouped
// result panel renders it as a "Flow catalog" destination row. Observable DOM only — never internals.
describe('install examples view — renders the flow-catalog result group (§18.1)', () => {
  const PREVIEW_ID = 'preview-1' as InstallPreviewId;
  const FLOW_CATALOG = 'flowCatalog' as InstallDestinationId;
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  const rels = (...p: string[]): DestRelativePath[] => p as DestRelativePath[];
  const button = (): HTMLButtonElement => host.querySelector('.kprofile button') as HTMLButtonElement;
  const reportGroup = (id: InstallDestinationId): HTMLElement | null =>
    host.querySelector(`.install-report [data-destination="${id}"]`);

  const catalogResult: InstallExamplesResult = {
    ok: true,
    created: [{ destination: FLOW_CATALOG, files: rels(path.join('feature-dev', 'flow.yaml')) }],
    overwritten: [],
    skipped: [],
    notInstalled: [],
    removed: [],
  };
  const deps: InstallExamplesDeps = {
    preview: vi.fn(
      async (): Promise<InstallExamplesPreview> => ({ ok: true, previewId: PREVIEW_ID, destinations: [], retired: [], retiredFallback: null, alwaysReplaced: [] }),
    ),
    apply: vi.fn(async (): Promise<InstallExamplesResult> => catalogResult),
  };

  it('shows a "Flow catalog" group in the report when the install seeds the catalog', async () => {
    createInstallExamples(host, deps);
    button().click();
    await vi.waitFor(() => expect(reportGroup(FLOW_CATALOG)).not.toBeNull(), { timeout: 500 });
    expect(reportGroup(FLOW_CATALOG)?.textContent).toContain('Flow catalog');
  });
});
