// Production render seams for the artifact viewer (§20.2): markdown-it (+ mermaid for
// fenced ```mermaid blocks) and a read-only CodeMirror 6 editor for code. The heavy libs
// are loaded lazily (dynamic import → separate Vite chunks) so they cost nothing until an
// artifact is actually opened. These are the real impls injected into `createArtifacts`;
// the organism itself is library-agnostic and unit-tested with fakes (artifacts.ts).
//
// Selection-to-send works off the live DOM selection (both markdown HTML and CodeMirror's
// content are real selectable DOM), so neither path needs a bespoke selection reader.

import type MarkdownItLib from 'markdown-it';

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
  })();
}

/** Render code read-only and syntax-highlighted in a CodeMirror 6 editor. */
export function renderCodeInto(body: string, lang: string | undefined, into: HTMLElement): void {
  const token = ++renderSeq;
  into.classList.remove('md');
  into.textContent = '…';
  void (async () => {
    const [{ EditorView, basicSetup }, { EditorState }, { javascript }] = await Promise.all([
      import('codemirror'),
      import('@codemirror/state'),
      import('@codemirror/lang-javascript'),
    ]);
    if (token !== renderSeq) return;
    into.replaceChildren();
    // Chrome follows the app theme via tokens; basicSetup's default highlight stays (§24.1C polish).
    const cmTheme = EditorView.theme({
      '&': { backgroundColor: 'transparent', color: 'var(--ink)', fontSize: '13px' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--muted)', border: 'none' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
    });
    const isTs = lang === 'typescript' || lang === 'ts' || lang === 'tsx';
    const isJsLike = isTs || lang === 'javascript' || lang === 'js' || lang === 'jsx';
    new EditorView({
      parent: into,
      state: EditorState.create({
        doc: body,
        extensions: [
          basicSetup,
          ...(isJsLike ? [javascript({ typescript: isTs })] : []),
          EditorView.editable.of(false),
          EditorState.readOnly.of(true),
          cmTheme,
        ],
      }),
    });
  })();
}
