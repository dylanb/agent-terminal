// Production render seams for the artifact viewer (§20.2): the real impls injected into
// `createArtifacts`, which is itself library-agnostic and unit-tested with fakes (artifacts.ts).

import type MarkdownItLib from 'markdown-it';
import type { Extension } from '@codemirror/state';
import type { Decoration as DecorationT, EditorView as EditorViewT } from '@codemirror/view';
import type { CodeView } from './artifacts';

// Per-host render token: guards against a stale async render overwriting a newer one into the same
// host. Keyed by host (not a single global counter) so a render into one placement never invalidates
// an in-flight render into another (relocation / future side-by-side viewers, §20.2).
const renderTokens = new WeakMap<HTMLElement, number>();
const bumpToken = (into: HTMLElement): number => {
  const next = (renderTokens.get(into) ?? 0) + 1;
  renderTokens.set(into, next);
  return next;
};
const tokenOf = (into: HTMLElement): number => renderTokens.get(into) ?? 0;

// A re-render must destroy the prior CodeMirror view before mounting another into the same host:
// removing the DOM alone leaks the document/window handlers CM releases only in destroy() (§20.2).
const mountedViews = new WeakMap<HTMLElement, EditorViewT>();
function teardownView(into: HTMLElement): void {
  const prev = mountedViews.get(into);
  if (prev) {
    prev.destroy();
    mountedViews.delete(into);
  }
}

let mdInstance: MarkdownItLib | null = null;
async function getMarkdownIt(): Promise<MarkdownItLib> {
  if (!mdInstance) {
    const MarkdownIt = (await import('markdown-it')).default;
    mdInstance = new MarkdownIt({ html: false, linkify: true, typographer: true });
  }
  return mdInstance;
}

let mermaidSeq = 0;

/** Render markdown into `into`, then turn any ```mermaid fences into rendered SVG. */
export function renderMarkdownInto(body: string, into: HTMLElement): void {
  const token = bumpToken(into);
  teardownView(into); // disposes any code view this host held (§20.2)
  into.classList.add('md');
  into.textContent = '…';
  // TODO(viewer): the catch degrades a chunk-load/render failure to raw text instead of a stuck
  // ellipsis. Untestable — markdown-it/mermaid are import()-ed here (no seam), so neither vitest
  // nor e2e can force the import to reject without a production seam added only for the test.
  void (async () => {
    const md = await getMarkdownIt();
    if (token !== tokenOf(into)) return;
    into.innerHTML = md.render(body);
    const fences = [...into.querySelectorAll('code.language-mermaid')];
    if (fences.length === 0) return;
    const theme = into.ownerDocument.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
    for (const code of fences) {
      if (token !== tokenOf(into)) return;
      const def = code.textContent ?? '';
      const slot = into.ownerDocument.createElement('div');
      slot.className = 'mermaid';
      (code.closest('pre') ?? code).replaceWith(slot);
      try {
        const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, def);
        if (token !== tokenOf(into)) return;
        slot.innerHTML = svg;
      } catch {
        slot.textContent = def; // a malformed diagram degrades to its source, never crashes
      }
    }
  })().catch(() => {
    if (token === tokenOf(into)) into.textContent = body; // degrade to raw text, never an unhandled rejection
  });
}

/**
 * Render code read-only and syntax-highlighted in a CodeMirror 6 editor. `changedLines` are
 * 1-based current-file lines that differ from HEAD (§20.2). Returns a handle for changed-section
 * navigation; a reveal requested before the editor's async build finishes is replayed once it exists.
 */
export function renderCodeInto(
  body: string,
  lang: string | undefined,
  into: HTMLElement,
  changedLines?: number[],
): CodeView {
  const token = bumpToken(into);
  teardownView(into); // §20.2
  into.classList.remove('md');
  into.textContent = '…';
  // TODO(viewer): see renderMarkdownInto — the trailing catch degrades a CodeMirror chunk-load
  // failure to raw text instead of a stuck ellipsis; untestable for the same import()-seam reason.
  let editor: EditorViewT | null = null;
  let EV: typeof EditorViewT | null = null;
  let pending: number | null = null;
  let detachScroll: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());
  const reveal = (line: number): void => {
    if (!editor || !EV) {
      pending = line;
      return;
    }
    const { doc } = editor.state;
    if (line < 1 || line > doc.lines) return;
    editor.dispatch({ effects: EV.scrollIntoView(doc.line(line).from, { y: 'center' }) });
  };
  const visibleLines = (): { top: number; bottom: number } => {
    if (!editor) return { top: 1, bottom: 1 };
    const sd = editor.scrollDOM;
    const { doc } = editor.state;
    const top = doc.lineAt(editor.lineBlockAtHeight(sd.scrollTop).from).number;
    const bottom = doc.lineAt(editor.lineBlockAtHeight(sd.scrollTop + sd.clientHeight).from).number;
    return { top, bottom };
  };
  void (async () => {
    const [{ EditorView, basicSetup }, { EditorState, StateField, RangeSetBuilder }, view, { javascript }] =
      await Promise.all([
        import('codemirror'),
        import('@codemirror/state'),
        import('@codemirror/view'),
        import('@codemirror/lang-javascript'),
      ]);
    if (token !== tokenOf(into)) return;
    into.replaceChildren();
    const cmTheme = EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--ink)', fontSize: '13px' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', border: 'none' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
      '.cm-changeGutter': { width: '3px', padding: '0' },
      '.cm-changedGutter': { width: '3px', height: '100%', backgroundColor: 'var(--changed)' },
      '.cm-changedLine': { backgroundColor: 'var(--changed-wash)' },
    });

    const changed = new Set(changedLines ?? []);
    const changeExt = buildChangeExtensions(changed, { EditorView, StateField, RangeSetBuilder }, view);

    const isTs = lang === 'typescript' || lang === 'ts' || lang === 'tsx';
    const isJsLike = isTs || lang === 'javascript' || lang === 'js' || lang === 'jsx';
    editor = new EditorView({
      parent: into,
      state: EditorState.create({
        doc: body,
        extensions: [
          basicSetup,
          ...(isJsLike ? [javascript({ typescript: isTs })] : []),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          cmTheme,
          EditorView.updateListener.of((u) => { if (u.geometryChanged) notify(); }),
          ...changeExt,
        ],
      }),
    });
    EV = EditorView;
    mountedViews.set(into, editor);
    // The read-only editor isn't editable-focusable, so its scroller needs to be a keyboard-reachable
    // labelled region — otherwise the code can't be scrolled by keyboard (§20.2 a11y).
    editor.scrollDOM.tabIndex = 0;
    editor.scrollDOM.setAttribute('role', 'region');
    editor.scrollDOM.setAttribute('aria-label', 'File contents');
    const sd = editor.scrollDOM;
    sd.addEventListener('scroll', notify);
    detachScroll = () => sd.removeEventListener('scroll', notify);
    if (pending !== null) {
      reveal(pending);
      pending = null;
    }
    notify(); // the real viewport is only knowable now the editor is laid out
  })().catch(() => {
    if (token === tokenOf(into)) {
      into.textContent = body; // degrade to raw text, never an unhandled rejection
      // The editor never mounted, so the host itself is the scroll region; restore keyboard
      // reachability the caller surrendered to the (never-built) editor (§20.2).
      into.tabIndex = 0;
    }
  });
  return {
    revealLine: reveal,
    visibleLines,
    onViewportChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      bumpToken(into); // a still-in-flight build bails at its token check before it mounts the editor
      teardownView(into);
      detachScroll?.();
      detachScroll = null;
      listeners.clear();
    },
  };
}

type CmState = typeof import('@codemirror/state');
type CmView = typeof import('@codemirror/view');

/** CodeMirror extensions decorating each changed line; empty set → no extensions. */
function buildChangeExtensions(
  changed: Set<number>,
  s: { EditorView: CmView['EditorView']; StateField: CmState['StateField']; RangeSetBuilder: CmState['RangeSetBuilder'] },
  view: CmView,
): Extension[] {
  if (changed.size === 0) return [];
  const { Decoration, gutter, GutterMarker } = view;

  const tintField = s.StateField.define({
    create(state) {
      const b = new s.RangeSetBuilder<DecorationT>();
      // RangeSetBuilder requires ascending positions; iterating changed lines (not 1..doc.lines)
      // also keeps a few changes in a large file O(changes), not O(totalLines).
      for (const n of [...changed].sort((a, z) => a - z)) {
        if (n >= 1 && n <= state.doc.lines) b.add(state.doc.line(n).from, state.doc.line(n).from, Decoration.line({ class: 'cm-changedLine' }));
      }
      return b.finish();
    },
    update: (value) => value, // read-only doc: positions never shift
    provide: (f) => s.EditorView.decorations.from(f),
  });

  const stripe = new (class extends GutterMarker {
    // host-document invariant (UI-STANDARDS): build in the EditorView's own document, not global.
    toDOM(view: EditorViewT): Node {
      const el = view.dom.ownerDocument.createElement('div');
      el.className = 'cm-changedGutter';
      return el;
    }
  })();
  const changeGutter = gutter({
    class: 'cm-changeGutter',
    lineMarker: (v, line) => (changed.has(v.state.doc.lineAt(line.from).number) ? stripe : null),
  });

  return [tintField, changeGutter];
}
