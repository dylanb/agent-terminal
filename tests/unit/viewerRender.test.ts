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

  it('concurrent renders into two different hosts do not invalidate each other (per-host token)', async () => {
    // The stale-render guard must be per-host: a render started in host B must not cancel an
    // in-flight render into host A. With a single global token, A would bail and never mount.
    const a = document.createElement('div');
    const b = document.createElement('div');
    document.body.append(a, b);
    renderCodeInto('const a = 1;', 'ts', a);
    renderCodeInto('const b = 2;', 'ts', b); // started while A is still building
    await vi.waitFor(() => {
      expect(a.querySelector('.cm-editor')).toBeTruthy();
      expect(b.querySelector('.cm-editor')).toBeTruthy();
    });
  });

  it('destroy() removes the scrollDOM listener and clears subscribers so viewport callbacks stop', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = renderCodeInto('const a = 1;\n'.repeat(40), 'ts', host);
    await vi.waitFor(() => expect(host.querySelector('.cm-scroller')).toBeTruthy());
    const scroller = host.querySelector('.cm-scroller') as HTMLElement;
    let calls = 0;
    view.onViewportChange(() => calls++);
    view.destroy!();
    scroller.dispatchEvent(new Event('scroll'));
    expect(calls).toBe(0);
  });

  // §20.2 a11y: the highlighter must emit the viewer's own themed classes, which `styles.css` colors
  // from tokens per theme. CodeMirror's built-in fallback style hard-codes light-background colors,
  // so under `data-theme="dark"` it paints unreadable code (WCAG 1.4.3).
  it('highlights code with the viewer\'s themed syntax classes, not the library default', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    renderCodeInto('const answer = 42; // why\n', 'ts', host);
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).toBeTruthy());
    await vi.waitFor(() => {
      expect(host.querySelector('.cm-syn-keyword')?.textContent).toBe('const');
      expect(host.querySelector('.cm-syn-number')?.textContent).toBe('42');
      expect(host.querySelector('.cm-syn-comment')?.textContent).toBe('// why');
    });
  });

  it('the returned CodeView.destroy() tears down the editor (for the organism dispose path)', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = renderCodeInto('const a = 1;', 'ts', host);
    await vi.waitFor(() => expect(host.querySelector('.cm-editor')).toBeTruthy());
    const destroy = vi.spyOn(EditorView.prototype, 'destroy');
    view.destroy!();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
