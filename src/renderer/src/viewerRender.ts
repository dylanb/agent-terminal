// Production render seams for the artifact viewer (§20.2): markdown-it (+ mermaid for
// fenced ```mermaid blocks) and a read-only CodeMirror 6 editor for code. The heavy libs
// are loaded lazily (dynamic import → separate Vite chunks) so they cost nothing until an
// artifact is actually opened. These are the real impls injected into `createArtifacts`;
// the organism itself is library-agnostic and unit-tested with fakes (artifacts.ts).
//
// Selection-to-send works off the live DOM selection (both markdown HTML and CodeMirror's
// content are real selectable DOM), so neither path needs a bespoke selection reader.

import type MarkdownItLib from 'markdown-it';
import type { Extension } from '@codemirror/state';
import type { Decoration as DecorationT, EditorView as EditorViewT } from '@codemirror/view';
import type { CodeView } from './artifacts';

let renderSeq = 0; // guards against a stale async render overwriting a newer one

// markdown-it instance is created once, then reused.
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
  const token = ++renderSeq;
  into.classList.add('md');
  into.textContent = '…';
  // TODO(viewer): the catch degrades a chunk-load/render failure to raw text instead of a stuck
  // ellipsis. Untestable — markdown-it/mermaid are import()-ed here (no seam), so neither vitest
  // nor e2e can force the import to reject without a production seam added only for the test.
  void (async () => {
    const md = await getMarkdownIt();
    if (token !== renderSeq) return; // a newer artifact was opened
    into.innerHTML = md.render(body);
    const fences = [...into.querySelectorAll('code.language-mermaid')];
    if (fences.length === 0) return;
    const theme = into.ownerDocument.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
    for (const code of fences) {
      if (token !== renderSeq) return;
      const def = code.textContent ?? '';
      const slot = into.ownerDocument.createElement('div');
      slot.className = 'mermaid';
      (code.closest('pre') ?? code).replaceWith(slot);
      try {
        const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, def);
        if (token !== renderSeq) return;
        slot.innerHTML = svg;
      } catch {
        slot.textContent = def; // a malformed diagram degrades to its source, never crashes
      }
    }
  })().catch(() => {
    if (token === renderSeq) into.textContent = body; // degrade to raw text, never an unhandled rejection
  });
}

/**
 * Render code read-only and syntax-highlighted in a CodeMirror 6 editor. `changedLines` are
 * 1-based current-file lines that differ from HEAD (§20.2); each is marked with both a gutter
 * stripe and a line-background tint. The doc is read-only, so the decorations are static.
 * Returns a handle for changed-section navigation; a reveal requested before the editor has
 * finished its async build is replayed once it exists.
 */
export function renderCodeInto(
  body: string,
  lang: string | undefined,
  into: HTMLElement,
  changedLines?: number[],
): CodeView {
  const token = ++renderSeq;
  into.classList.remove('md');
  into.textContent = '…';
  // TODO(viewer): see renderMarkdownInto — the trailing catch degrades a CodeMirror chunk-load
  // failure to raw text instead of a stuck ellipsis; untestable for the same import()-seam reason.
  let editor: EditorViewT | null = null;
  let EV: typeof EditorViewT | null = null;
  let pending: number | null = null;
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
    if (token !== renderSeq) return;
    into.replaceChildren();
    // Chrome follows the app theme via tokens; basicSetup's default highlight stays (§24.1C polish).
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
          // Resize changes which lines are visible; scroll is caught on scrollDOM below (§20.2).
          EditorView.updateListener.of((u) => { if (u.geometryChanged) notify(); }),
          ...changeExt,
        ],
      }),
    });
    EV = EditorView;
    // The read-only editor isn't editable-focusable, so make its scroller a keyboard-reachable,
    // labelled scroll region — otherwise there's no way to scroll the code by keyboard (§20.2 a11y).
    editor.scrollDOM.tabIndex = 0;
    editor.scrollDOM.setAttribute('role', 'region');
    editor.scrollDOM.setAttribute('aria-label', 'File contents');
    editor.scrollDOM.addEventListener('scroll', notify);
    if (pending !== null) {
      reveal(pending);
      pending = null;
    }
    notify(); // the real viewport is only knowable now the editor is laid out
  })().catch(() => {
    if (token === renderSeq) into.textContent = body; // degrade to raw text, never an unhandled rejection
  });
  return {
    revealLine: reveal,
    visibleLines,
    onViewportChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

type CmState = typeof import('@codemirror/state');
type CmView = typeof import('@codemirror/view');

/** A gutter stripe + a line-background tint on each changed line. Empty set → no extensions. */
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
      for (let n = 1; n <= state.doc.lines; n++) {
        if (changed.has(n)) b.add(state.doc.line(n).from, state.doc.line(n).from, Decoration.line({ class: 'cm-changedLine' }));
      }
      return b.finish();
    },
    update: (value) => value, // read-only doc: positions never shift
    provide: (f) => s.EditorView.decorations.from(f),
  });

  const stripe = new (class extends GutterMarker {
    toDOM(): Node {
      const el = document.createElement('div');
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
