// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createArtifacts, selectionWithin } from '../../src/renderer/src/artifacts';
import { FOCUS_VIEW_EVENT } from '../../src/renderer/src/paneActions';
import type { ArtifactTree, ViewerFile } from '../../src/shared/ipc';
import { assertRendersFromHostDocument } from './relocatable';

// §20.1/§20.2 artifact viewer organism: a hierarchical file tree fed by real discovery
// (loadTree) and a viewer that reads file content (loadFile) through injected seams, with a
// selection routed to the two §16.2 sinks. The heavy markdown/CodeMirror impls and the real
// git/fs discovery are injected; here they are faked so the test observes the organism's own
// DOM/sink behavior, not the libraries or the filesystem.

const TREE_CURATED: ArtifactTree = {
  root: '/repo',
  isRepo: true,
  scope: 'curated',
  nodes: [
    {
      name: 'src',
      relPath: 'src',
      kind: 'dir',
      children: [{ name: 'a.ts', relPath: 'src/a.ts', kind: 'file', provenance: ['changed'] }],
    },
    { name: 'review.md', relPath: 'review.md', kind: 'file', provenance: ['loop'] },
  ],
};
const TREE_REPO: ArtifactTree = {
  root: '/repo',
  isRepo: true,
  scope: 'repo',
  nodes: [
    {
      name: 'src',
      relPath: 'src',
      kind: 'dir',
      children: [
        { name: 'a.ts', relPath: 'src/a.ts', kind: 'file', provenance: ['changed'] },
        { name: 'b.ts', relPath: 'src/b.ts', kind: 'file' },
      ],
    },
    { name: 'review.md', relPath: 'review.md', kind: 'file', provenance: ['loop'] },
  ],
};
const TREE_PLAIN: ArtifactTree = {
  root: '/tmp/dir',
  isRepo: false,
  scope: 'curated',
  nodes: [{ name: 'note.txt', relPath: 'note.txt', kind: 'file' }],
};

function fileFor(relPath: string): ViewerFile {
  const md = relPath.endsWith('.md');
  return {
    relPath,
    name: relPath.split('/').pop()!,
    kind: md ? 'markdown' : 'code',
    lang: md ? undefined : 'typescript',
    body: `body of ${relPath}`,
  };
}

function mount(tree: ArtifactTree = TREE_CURATED, over: Partial<Parameters<typeof createArtifacts>[1]> = {}) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const loadTree = vi.fn(async (scope: 'curated' | 'repo') => (scope === 'repo' ? TREE_REPO : tree));
  const loadFile = vi.fn(async (relPath: string) => fileFor(relPath));
  const renderMarkdown = vi.fn((body: string, into: HTMLElement) => { into.textContent = body; });
  const renderCode = vi.fn((body: string, _lang: string | undefined, into: HTMLElement) => { into.textContent = body; });
  const send = vi.fn();
  const addToTodo = vi.fn();
  let selection = '';
  const readSelection = vi.fn(() => selection);
  const api = createArtifacts(host, { loadTree, loadFile, renderMarkdown, renderCode, send, addToTodo, readSelection, ...over });
  return {
    host, api, loadTree, loadFile, renderMarkdown, renderCode, send, addToTodo,
    setSelection: (s: string) => { selection = s; },
    fileRows: () => [...host.querySelectorAll('.tree .f')] as HTMLElement[],
    dirRows: () => [...host.querySelectorAll('.tree .dir > .dname')] as HTMLElement[],
    body: () => host.querySelector('.vbody') as HTMLElement,
    title: () => host.querySelector('.vtitle') as HTMLElement,
    checkbox: () => host.querySelector('.scope-toggle input') as HTMLInputElement | null,
    scopeToggle: () => host.querySelector('.scope-toggle') as HTMLElement | null,
    search: () => host.querySelector('.treesearch') as HTMLInputElement,
    treeitems: () => [...host.querySelectorAll('.treelist [role="treeitem"]')] as HTMLElement[],
    divider: () => host.querySelector('.artsplit-divider') as HTMLElement,
    artsplit: () => host.querySelector('.artsplit') as HTMLElement,
    width: () => (host.querySelector('.artsplit') as HTMLElement).style.getPropertyValue('--tree-w'),
  };
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k, bubbles: true });
const mouse = (type: string, clientX: number) => new MouseEvent(type, { clientX, bubbles: true });

// A controllable stand-in for the CodeMirror viewport (§20.2): revealLine recentres a
// fixed-height window on the target line; scrollTo simulates a manual scroll. Both notify
// subscribers, exactly as the real editor's scroll events drive the organism's readout.
function fakeCodeView(top: number, bottom: number) {
  const win = bottom - top;
  const listeners = new Set<() => void>();
  const state = { top, bottom };
  const notify = () => listeners.forEach((l) => l());
  return {
    revealLine: vi.fn((line: number) => {
      state.top = Math.max(1, line - Math.floor(win / 2));
      state.bottom = state.top + win;
      notify();
    }),
    visibleLines: () => ({ top: state.top, bottom: state.bottom }),
    onViewportChange: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); },
    scrollTo: (t: number, b: number) => { state.top = t; state.bottom = b; notify(); },
    destroy: vi.fn(),
  };
}

beforeEach(() => { document.body.replaceChildren(); });

describe('focus on view activation (§22.4)', () => {
  const announce = (view: string) => window.dispatchEvent(new CustomEvent(FOCUS_VIEW_EVENT, { detail: { view } }));

  it('focuses the first tree item when the Artifacts view is announced (keyboard nav is immediate)', async () => {
    const v = mount();
    await v.api.refresh();
    announce('2');
    expect(document.activeElement).toBe(v.treeitems()[0]);
  });

  it('ignores announcements for other views', async () => {
    const v = mount();
    await v.api.refresh();
    announce('1');
    expect(document.activeElement).not.toBe(v.treeitems()[0]);
  });
});

describe('artifact viewer (§20.1/§20.2 — real discovery)', () => {
  it('renders the discovered tree hierarchically: a directory node containing its files', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.dirRows().map((d) => d.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('src')]));
    const srcDir = [...v.host.querySelectorAll('.tree .dir')].find((d) => d.querySelector('.dname')?.textContent?.includes('src'));
    expect(srcDir?.querySelector('.f')?.textContent).toContain('a.ts');
  });

  it('shows per-file provenance tags (changed / loop)', async () => {
    const v = mount();
    await v.api.refresh();
    const review = v.fileRows().find((r) => r.textContent?.includes('review.md'))!;
    expect(review.textContent).toContain('loop');
    const aTs = v.fileRows().find((r) => r.textContent?.includes('a.ts'))!;
    expect(aTs.textContent).toContain('changed');
  });

  it('opens the first file by default, reading it through loadFile and the render seam', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.loadFile).toHaveBeenCalled();
    expect(v.renderCode).toHaveBeenCalledWith('body of src/a.ts', 'typescript', v.body(), undefined);
    expect(v.title().textContent).toContain('a.ts');
  });

  it('passes the file\'s changed lines to the code render seam (§20.2)', async () => {
    const v = mount(undefined, {
      loadFile: async (relPath: string) => ({ ...fileFor(relPath), changedLines: [2, 5] }),
    });
    await v.api.refresh();
    expect(v.renderCode).toHaveBeenCalledWith('body of src/a.ts', 'typescript', v.body(), [2, 5]);
  });

  // Keyboard a11y (§20.2): the scrolling container must be tab-reachable so it can be scrolled by
  // keyboard. For markdown that container is the body itself; for code it's the editor's scroller,
  // so the body steps aside (tabindex -1) and the editor takes focus.
  it('makes the viewer body a focusable, labelled scroll region for markdown', async () => {
    const v = mount();
    await v.api.refresh();
    v.fileRows().find((r) => r.textContent?.includes('review.md'))!.click();
    await Promise.resolve(); await Promise.resolve();
    const body = v.body();
    expect(body.tabIndex).toBe(0);
    expect(body.getAttribute('role')).toBe('region');
    expect(body.getAttribute('aria-label')).toContain('review.md');
  });

  // (body-tab-stop behavior for code files is covered by the renderCode-fallback vs editor-scroller
  // pair below — a real editor owns its scroller so the body leaves the tab order; the plain
  // fallback keeps the body focusable.)

  // Tweak 2: contiguous changed lines collapse into sections; the readout and prev/next are
  // derived from the live viewport — current = the last section scrolled onto/past the screen,
  // prev/next jump to the nearest section above/below the visible area (§20.2).
  const navOf = (v: ReturnType<typeof mount>) => ({
    count: v.host.querySelector('.art-navcount') as HTMLElement,
    prev: v.host.querySelector('.art-prev') as HTMLButtonElement,
    next: v.host.querySelector('.art-next') as HTMLButtonElement,
  });

  it('dispose() destroys the live code view so CodeMirror handlers are released (§20.2)', async () => {
    const cv = fakeCodeView(1, 20);
    const v = mount(undefined, { renderCode: vi.fn(() => cv) });
    await v.api.refresh(); // opens the first (code) file → mounts the code view
    v.api.dispose();
    expect(cv.destroy).toHaveBeenCalledTimes(1);
  });

  it('tracks the viewport, stepping prev/next to the nearest off-screen change (§20.2)', async () => {
    const cv = fakeCodeView(1, 20); // [2,3] · [50] · [90,91]
    const v = mount(undefined, {
      loadFile: async (relPath: string) => ({ ...fileFor(relPath), changedLines: [2, 3, 50, 90, 91] }),
      renderCode: vi.fn(() => cv),
    });
    await v.api.refresh();
    const { count, prev, next } = navOf(v);
    expect(count.textContent).toBe('1 / 3'); // open at top → only change 1 is on screen
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    next.click();
    expect(cv.revealLine).toHaveBeenLastCalledWith(50);
    expect(count.textContent).toBe('2 / 3');
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    next.click();
    expect(cv.revealLine).toHaveBeenLastCalledWith(90);
    expect(count.textContent).toBe('3 / 3');
    expect(next.disabled).toBe(true); // last change → nowhere below
    prev.click();
    expect(cv.revealLine).toHaveBeenLastCalledWith(50);
    expect(count.textContent).toBe('2 / 3');
  });

  it('reaches the only change with next when it is off-screen at open (§20.2)', async () => {
    const cv = fakeCodeView(1, 20);
    const v = mount(undefined, {
      loadFile: async (relPath: string) => ({ ...fileFor(relPath), changedLines: [100] }),
      renderCode: vi.fn(() => cv),
    });
    await v.api.refresh();
    const { count, prev, next } = navOf(v);
    expect(count.textContent).toBe('1 / 1');
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false); // the single change is below the fold — reachable
    next.click();
    expect(cv.revealLine).toHaveBeenCalledWith(100);
    expect(next.disabled).toBe(true); // now on screen → both ends exhausted
    expect(prev.disabled).toBe(true);
  });

  it('updates the current number as changes scroll into view (§20.2)', async () => {
    const cv = fakeCodeView(1, 20);
    const v = mount(undefined, {
      loadFile: async (relPath: string) => ({ ...fileFor(relPath), changedLines: [2, 50, 90] }),
      renderCode: vi.fn(() => cv),
    });
    await v.api.refresh();
    const { count } = navOf(v);
    expect(count.textContent).toBe('1 / 3');
    cv.scrollTo(45, 64); // change 2 (line 50) scrolls into view
    expect(count.textContent).toBe('2 / 3');
    cv.scrollTo(85, 104); // change 3 (line 90) scrolls into view
    expect(count.textContent).toBe('3 / 3');
  });

  it('hides the changed-section controls for a file with no changes (§20.2)', async () => {
    const v = mount(); // fileFor() carries no changedLines
    await v.api.refresh();
    expect((v.host.querySelector('.vnav') as HTMLElement).hidden).toBe(true);
  });

  // Full-screen viewer (§20.2): the organism owns the in-viewer presentation and the toggle
  // button; it requests the chrome change through the contract and reflects state set back.
  it('requests the full-screen toggle through the contract (§20.2)', async () => {
    const onRequestFullscreen = vi.fn();
    const v = mount(TREE_CURATED, { onRequestFullscreen });
    await v.api.refresh();
    const fs = v.host.querySelector('.art-fs') as HTMLButtonElement;
    fs.click();
    expect(onRequestFullscreen).toHaveBeenLastCalledWith(true);
    v.api.setFullscreen(true);
    fs.click();
    expect(onRequestFullscreen).toHaveBeenLastCalledWith(false);
  });

  it('enters maximal view with the header and tree collapsed (§20.2)', async () => {
    const v = mount();
    await v.api.refresh();
    const split = v.artsplit();
    const fs = v.host.querySelector('.art-fs') as HTMLButtonElement;
    const vbar = v.host.querySelector('.vbar') as HTMLElement;
    const tree = v.host.querySelector('.tree') as HTMLElement;
    v.api.setFullscreen(true);
    expect(v.api.isFullscreen()).toBe(true);
    expect(split.classList.contains('fullscreen')).toBe(true);
    expect(vbar.classList.contains('is-collapsed')).toBe(true); // both collapsed (inert) on enter
    expect(tree.classList.contains('is-collapsed')).toBe(true);
    expect(fs.getAttribute('aria-pressed')).toBe('true');
    v.api.setFullscreen(false);
    expect(split.classList.contains('fullscreen')).toBe(false);
    expect(vbar.classList.contains('is-collapsed')).toBe(false); // restored for the normal split
    expect(tree.classList.contains('is-collapsed')).toBe(false);
    expect(fs.getAttribute('aria-pressed')).toBe('false');
  });

  it('the edge strips pop the header and tree open and closed, reflecting aria-expanded (§20.2)', async () => {
    const v = mount();
    await v.api.refresh();
    v.api.setFullscreen(true);
    const vbar = v.host.querySelector('.vbar') as HTMLElement;
    const tree = v.host.querySelector('.tree') as HTMLElement;
    const top = v.host.querySelector('.fs-strip-top') as HTMLButtonElement;
    const left = v.host.querySelector('.fs-strip-left') as HTMLButtonElement;
    expect(top.getAttribute('aria-expanded')).toBe('false');
    top.click();
    expect(vbar.classList.contains('is-collapsed')).toBe(false); // header revealed (inert → visible)
    expect(top.getAttribute('aria-expanded')).toBe('true');
    top.click();
    expect(vbar.classList.contains('is-collapsed')).toBe(true);
    expect(top.getAttribute('aria-expanded')).toBe('false');
    left.click();
    expect(tree.classList.contains('is-collapsed')).toBe(false);
    expect(left.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves focus to a reveal strip on enter and back to the toggle on exit (§20.2 a11y)', async () => {
    const v = mount();
    await v.api.refresh();
    v.api.setFullscreen(true);
    expect(document.activeElement).toBe(v.host.querySelector('.fs-strip-top'));
    v.api.setFullscreen(false);
    expect(document.activeElement).toBe(v.host.querySelector('.art-fs'));
  });

  // The full-screen tree overlay is resizable with its own remembered width, defaulting wide.
  const fsWidth = (v: ReturnType<typeof mount>) =>
    parseFloat(v.artsplit().style.getPropertyValue('--tree-w-fs'));

  it('the full-screen tree popout defaults to at least 30% of the viewport (§20.2)', async () => {
    const v = mount();
    await v.api.refresh();
    expect(fsWidth(v)).toBeGreaterThanOrEqual(0.3 * window.innerWidth);
  });

  it('applies a persisted full-screen popout width over the default (§20.2)', async () => {
    const v = mount(TREE_CURATED, { initialFullscreenWidth: 560 });
    await v.api.refresh();
    expect(v.artsplit().style.getPropertyValue('--tree-w-fs')).toBe('560px');
  });

  it('drag-resizes the full-screen tree popout and persists the width (§20.2)', async () => {
    const onFullscreenWidthChange = vi.fn();
    const v = mount(TREE_CURATED, { initialFullscreenWidth: 400, onFullscreenWidthChange });
    await v.api.refresh();
    const handle = v.host.querySelector('.fs-tree-resize') as HTMLElement;
    handle.dispatchEvent(mouse('mousedown', 400));
    document.dispatchEvent(mouse('mousemove', 520));
    document.dispatchEvent(mouse('mouseup', 520));
    expect(fsWidth(v)).toBeCloseTo(520, 0);
    expect(onFullscreenWidthChange).toHaveBeenCalledWith(520);
  });

  it('arrow keys nudge the full-screen popout width and persist it (§20.2 a11y)', async () => {
    const onFullscreenWidthChange = vi.fn();
    const v = mount(TREE_CURATED, { initialFullscreenWidth: 400, onFullscreenWidthChange });
    await v.api.refresh();
    const handle = v.host.querySelector('.fs-tree-resize') as HTMLElement;
    handle.dispatchEvent(key('ArrowRight'));
    expect(fsWidth(v)).toBeGreaterThan(400);
    expect(onFullscreenWidthChange).toHaveBeenCalled();
  });

  it('clicking a markdown file reads and renders it through the markdown seam', async () => {
    const v = mount();
    await v.api.refresh();
    v.fileRows().find((r) => r.textContent?.includes('review.md'))!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(v.loadFile).toHaveBeenCalledWith('review.md');
    expect(v.renderMarkdown).toHaveBeenCalledWith('body of review.md', v.body());
  });

  it('the "show all repo files" checkbox re-discovers with the repo scope', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.scopeToggle()!.hidden).toBe(false);
    v.checkbox()!.click();
    await Promise.resolve(); await Promise.resolve();
    expect(v.loadTree).toHaveBeenCalledWith('repo');
    expect(v.fileRows().some((r) => r.textContent?.includes('b.ts'))).toBe(true);
  });

  it('hides the scope checkbox outside a git repo (the tree is already the whole dir)', async () => {
    const v = mount(TREE_PLAIN);
    await v.api.refresh();
    expect(v.scopeToggle()!.hidden).toBe(true);
    expect(v.fileRows().some((r) => r.textContent?.includes('note.txt'))).toBe(true);
  });

  it('filters the tree by the search box', async () => {
    const v = mount();
    await v.api.refresh();
    v.search().value = 'review';
    v.search().dispatchEvent(new Event('input'));
    expect(v.fileRows().filter((r) => !r.hidden).map((r) => r.textContent)).toEqual([expect.stringContaining('review.md')]);
  });

  it('filters by file name, not ancestor directory names (§20.2)', async () => {
    // A directory whose name contains the query must not drag in its non-matching files.
    const tree: ArtifactTree = {
      root: '/repo',
      isRepo: true,
      scope: 'curated',
      nodes: [
        {
          name: 'plans',
          relPath: 'plans',
          kind: 'dir',
          children: [
            { name: 'plan-a.md', relPath: 'plans/plan-a.md', kind: 'file' },
            { name: 'notes.md', relPath: 'plans/notes.md', kind: 'file' },
          ],
        },
      ],
    };
    const v = mount(tree);
    await v.api.refresh();
    v.search().value = 'plan';
    v.search().dispatchEvent(new Event('input'));
    // Only matching files are rendered at all (no reliance on a `hidden` attribute a CSS
    // `display` rule could override) — notes.md is gone though it lives in plans/.
    expect(v.fileRows().map((r) => r.textContent)).toEqual([expect.stringContaining('plan-a.md')]);
    expect(v.dirRows().map((d) => d.textContent)).toEqual([expect.stringContaining('plans')]); // hierarchy kept
  });

  it('clearing the filter restores the full tree (§20.2)', async () => {
    const v = mount();
    await v.api.refresh();
    v.search().value = 'review';
    v.search().dispatchEvent(new Event('input'));
    expect(v.fileRows()).toHaveLength(1);
    v.search().value = '';
    v.search().dispatchEvent(new Event('input'));
    expect(v.fileRows().length).toBeGreaterThan(1);
  });

  it('selectionWithin preserves raw formatting (code indentation/newlines) but empties whitespace-only', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const sel = document.getSelection()!;
    const range = document.createRange();

    host.textContent = '    indented line\n';
    range.selectNodeContents(host);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionWithin(host)).toBe('    indented line\n'); // not trimmed

    host.textContent = '   \n  ';
    range.selectNodeContents(host);
    sel.removeAllRanges();
    sel.addRange(range);
    expect(selectionWithin(host)).toBe(''); // whitespace-only → empty
  });

  it('Send to agent and Add to todo route the viewer selection to the sinks', async () => {
    const v = mount();
    await v.api.refresh();
    v.setSelection('a passage');
    document.dispatchEvent(new Event('selectionchange'));
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    (v.host.querySelector('.art-todo') as HTMLButtonElement).click();
    expect(v.send).toHaveBeenCalledWith('a passage');
    expect(v.addToTodo).toHaveBeenCalledWith('a passage');
  });


  // Tweak 1: the two sinks are inert until there is a highlight to act on.
  it('disables Send to agent and Add to todo until something is highlighted (§20.2)', async () => {
    const v = mount();
    await v.api.refresh();
    const send = v.host.querySelector('.art-send') as HTMLButtonElement;
    const todo = v.host.querySelector('.art-todo') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(todo.disabled).toBe(true);
    v.setSelection('a passage');
    document.dispatchEvent(new Event('selectionchange'));
    expect(send.disabled).toBe(false);
    expect(todo.disabled).toBe(false);
    v.setSelection('');
    document.dispatchEvent(new Event('selectionchange'));
    expect(send.disabled).toBe(true);
    expect(todo.disabled).toBe(true);
  });

  it('a stale in-flight refresh cannot overwrite a newer one (cwd sync race)', async () => {
    // The newer refresh resolves first; the older one resolves LAST and must be ignored —
    // otherwise the mount discovery (process-dir) clobbers the cwd:changed discovery.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const resolvers: Array<(t: ArtifactTree) => void> = [];
    const loadTree = vi.fn((_s: 'curated' | 'repo') => new Promise<ArtifactTree>((res) => resolvers.push(res)));
    const api = createArtifacts(host, {
      loadTree,
      loadFile: async (relPath) => fileFor(relPath),
      send: vi.fn(),
      addToTodo: vi.fn(),
      renderMarkdown: (b, into) => { into.textContent = b; },
      renderCode: (b, _l, into) => { into.textContent = b; },
      readSelection: () => '',
    });
    const older = api.refresh();
    const newer = api.refresh();
    resolvers[resolvers.length - 1](TREE_REPO); // newer settles first → wins
    resolvers[resolvers.length - 2](TREE_CURATED); // older settles last → must be ignored
    resolvers[0]?.(TREE_CURATED); // settle the mount refresh
    await Promise.all([older, newer]);
    const files = [...host.querySelectorAll('.tree .f')].map((r) => r.textContent);
    expect(files.some((f) => f?.includes('b.ts'))).toBe(true); // TREE_REPO (the newer) is shown
  });

  it('does nothing when there is no selection to send', async () => {
    const v = mount();
    await v.api.refresh();
    v.setSelection('');
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    expect(v.send).not.toHaveBeenCalled();
  });

  // 1) Full name discoverable when truncated.
  it('sets the full relative path as a title on each file row', async () => {
    const v = mount();
    await v.api.refresh();
    const aTs = v.fileRows().find((r) => r.textContent?.includes('a.ts'))!;
    expect(aTs.title).toContain('src/a.ts');
  });

  // 2) Keyboard navigation (WAI-ARIA tree).
  it('exposes a tree with treeitem roles', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.host.querySelector('.treelist')!.getAttribute('role')).toBe('tree');
    expect(v.treeitems()[0].getAttribute('role')).toBe('treeitem');
  });

  it('ArrowDown/Up moves focus between visible tree rows', async () => {
    const v = mount();
    await v.api.refresh();
    const items = v.treeitems();
    items[0].focus();
    items[0].dispatchEvent(key('ArrowDown'));
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(key('ArrowUp'));
    expect(document.activeElement).toBe(items[0]);
  });

  it('Enter opens the focused file', async () => {
    const v = mount();
    await v.api.refresh();
    const file = v.fileRows().find((r) => r.textContent?.includes('review.md'))!;
    file.focus();
    file.dispatchEvent(key('Enter'));
    await Promise.resolve(); await Promise.resolve();
    expect(v.loadFile).toHaveBeenCalledWith('review.md');
  });

  it('ArrowRight expands and ArrowLeft collapses a focused directory', async () => {
    const v = mount();
    await v.api.refresh();
    const dir = v.host.querySelector('.tree .dir')!;
    const head = dir.querySelector('.dname') as HTMLElement;
    head.focus();
    head.dispatchEvent(key('ArrowLeft'));
    expect(dir.classList.contains('collapsed')).toBe(true);
    head.dispatchEvent(key('ArrowRight'));
    expect(dir.classList.contains('collapsed')).toBe(false);
  });

  // 3) Resizable tree pane via the edge.
  it('renders a separator between the tree and the viewer', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.divider().getAttribute('role')).toBe('separator');
  });

  it('the tree separator exposes its clamp range to assistive tech (aria-valuemin/max)', async () => {
    const v = mount();
    await v.api.refresh();
    expect(v.divider().getAttribute('aria-valuemin')).toBe('140');
    expect(v.divider().getAttribute('aria-valuemax')).toBe('640');
  });

  it('the full-screen popout separator exposes its clamp range (aria-valuemin/max)', async () => {
    const v = mount();
    await v.api.refresh();
    v.api.setFullscreen(true);
    const handle = v.host.querySelector('.fs-tree-resize') as HTMLElement;
    expect(handle.getAttribute('aria-valuemin')).toBe('200');
    expect(Number(handle.getAttribute('aria-valuemax'))).toBeGreaterThan(200);
  });

  it('applies the persisted initial width', async () => {
    const v = mount(TREE_CURATED, { initialWidth: 320 });
    await v.api.refresh();
    expect(v.width()).toBe('320px');
  });

  it('dragging the separator changes the tree width and persists it', async () => {
    const onWidthChange = vi.fn();
    const v = mount(TREE_CURATED, { initialWidth: 248, onWidthChange });
    await v.api.refresh();
    v.divider().dispatchEvent(mouse('mousedown', 248));
    document.dispatchEvent(mouse('mousemove', 300));
    document.dispatchEvent(mouse('mouseup', 300));
    expect(v.width()).toBe('300px');
    expect(onWidthChange).toHaveBeenCalledWith(300);
  });

  it('keeps the viewer body keyboard-focusable for code when renderCode has no editor (plain fallback)', async () => {
    const v = mount(); // default renderCode returns void → the body itself is the scroll container
    await v.api.refresh(); // opens the first (code) file
    expect(v.body().tabIndex).toBe(0);
  });

  it('removes the body from the tab order for code when the editor owns its scroller', async () => {
    const cv = fakeCodeView(1, 20);
    const v = mount(undefined, { renderCode: vi.fn(() => cv) });
    await v.api.refresh();
    expect(v.body().tabIndex).toBe(-1);
  });

  it('reflects the selected file to assistive tech via aria-selected (single-select tree)', async () => {
    const v = mount();
    await v.api.refresh(); // opens the first file
    const selected = v.fileRows().filter((r) => r.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].classList.contains('sel')).toBe(true);
    expect(v.fileRows().every((r) => r.hasAttribute('aria-selected'))).toBe(true);
  });

  it('wraps directory children in a role="group" container (ARIA tree hierarchy)', async () => {
    const v = mount();
    await v.api.refresh();
    const group = v.host.querySelector('.dchildren');
    expect(group).toBeTruthy();
    expect(group!.getAttribute('role')).toBe('group');
  });

  it('directory headers expose aria-expanded and sync it on click toggle', async () => {
    const v = mount();
    await v.api.refresh();
    const head = v.dirRows()[0];
    expect(head.getAttribute('aria-expanded')).toBe('true');
    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });

  it('keyboard collapse/expand keeps the directory aria-expanded in sync', async () => {
    const v = mount();
    await v.api.refresh();
    const head = v.dirRows()[0];
    head.dispatchEvent(key('Enter')); // collapse
    expect(head.getAttribute('aria-expanded')).toBe('false');
    head.dispatchEvent(key('ArrowRight')); // expand
    expect(head.getAttribute('aria-expanded')).toBe('true');
    head.dispatchEvent(key('ArrowLeft')); // collapse
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('dispose() removes in-flight drag listeners (a mid-drag unmount stops resizing)', async () => {
    const v = mount(TREE_CURATED, { initialWidth: 248 });
    await v.api.refresh();
    const split = v.artsplit();
    v.divider().dispatchEvent(mouse('mousedown', 248));
    v.api.dispose();
    document.dispatchEvent(mouse('mousemove', 400)); // would resize to 400px if the listener leaked
    expect(split.style.getPropertyValue('--tree-w')).toBe('248px');
  });

  it('recomputes the full-screen clamp ceiling on window resize (aria-valuemax not stale)', async () => {
    const v = mount();
    await v.api.refresh();
    v.api.setFullscreen(true);
    const handle = v.host.querySelector('.fs-tree-resize') as HTMLElement;
    const before = Number(handle.getAttribute('aria-valuemax'));
    const orig = window.innerWidth;
    try {
      (window as unknown as { innerWidth: number }).innerWidth = Math.round(orig / 2);
      window.dispatchEvent(new Event('resize'));
      expect(Number(handle.getAttribute('aria-valuemax'))).toBeLessThan(before);
    } finally {
      (window as unknown as { innerWidth: number }).innerWidth = orig;
    }
  });

  it('ArrowRight/Left on the separator nudges and persists the width', async () => {
    const onWidthChange = vi.fn();
    const v = mount(TREE_CURATED, { initialWidth: 248, onWidthChange });
    await v.api.refresh();
    v.divider().dispatchEvent(key('ArrowRight'));
    expect(v.width()).toBe('264px');
    expect(onWidthChange).toHaveBeenCalledWith(264);
  });

  // §20.2: IPC reads can reject (main-process restart). The viewer must degrade gracefully,
  // not throw an unhandled rejection from the `void open(...)` / `void refresh()` call sites.
  it('open() treats a loadFile rejection as an unreadable file (no unhandled rejection)', async () => {
    const v = mount(TREE_CURATED, { loadFile: vi.fn(async () => { throw new Error('ipc down'); }) });
    await v.api.refresh(); // opens the first file → loadFile rejects
    expect(v.host.textContent).toContain('Cannot display this file');
  });

  it('builds from host.ownerDocument, not the global document (UI-STANDARDS §3.3)', async () => {
    await assertRendersFromHostDocument(async (host) => {
      const api = createArtifacts(host, {
        loadTree: async (scope) => (scope === 'repo' ? TREE_REPO : TREE_CURATED),
        loadFile: async (relPath) => fileFor(relPath),
        renderMarkdown: (body, into) => { into.textContent = body; },
        renderCode: (body, _lang, into) => { into.textContent = body; },
        send: vi.fn(),
        addToTodo: vi.fn(),
        readSelection: () => '',
      });
      await api.refresh(); // drives a tree render under the host
    });
  });

  it('refresh() leaves the previous tree in place when loadTree rejects', async () => {
    const v = mount(TREE_CURATED);
    await v.api.refresh();
    const before = v.fileRows().length;
    expect(before).toBeGreaterThan(0);
    v.loadTree.mockRejectedValueOnce(new Error('ipc down'));
    await v.api.refresh(); // must not throw
    expect(v.fileRows().length).toBe(before); // previous tree intact
  });
});
