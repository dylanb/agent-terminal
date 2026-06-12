import { describe, expect, it } from 'vitest';
import { resolveRendererTarget } from '../../src/main/rendererTarget';

describe('resolveRendererTarget (§6 — dev server only in dev builds)', () => {
  it('uses the dev-server URL when unpackaged and the env var is set', () => {
    expect(resolveRendererTarget({ isPackaged: false, rendererUrl: 'http://localhost:5173' })).toEqual({
      kind: 'url',
      url: 'http://localhost:5173',
    });
  });

  it('loads the bundled file when unpackaged with no dev URL', () => {
    expect(resolveRendererTarget({ isPackaged: false, rendererUrl: undefined })).toEqual({ kind: 'file' });
  });

  it('ignores ELECTRON_RENDERER_URL in a packaged build', () => {
    expect(resolveRendererTarget({ isPackaged: true, rendererUrl: 'http://evil.example' })).toEqual({
      kind: 'file',
    });
  });
});
