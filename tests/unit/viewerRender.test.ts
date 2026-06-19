// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { renderCodeInto, renderMarkdownInto } from '../../src/renderer/src/viewerRender';

// §20.2: the render seams reuse the same host element across file opens. CodeMirror's EditorView
// attaches document/window handlers released only by view.destroy() — removing the DOM is not
// enough — so re-rendering into a host that already holds a view must destroy the old one first,
// else handlers leak over repeated opens. Observed via the shared EditorView.prototype.destroy
// (viewerRender import()s the same @codemirror/view module instance the test imports).

describe('viewerRender — EditorView lifecycle (no leak on re-render, §20.2)', () => {
  afterEach(() => vi.restoreAllMocks());

  async function mountCode(host: HTMLElement, body: string): Promise<void> {
    renderCodeInto(body, 'ts', host);
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).toBeTruthy());
  }

  it('destroys the prior view when re-rendering code into the same host', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mountCode(host, 'const a = 1;');
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    await mountCode(host, 'const b = 2;');
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('destroys the prior view when switching from code to markdown', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    await mountCode(host, 'const a = 1;');
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    renderMarkdownInto('# hi', host);
    await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(1));
  });
});
