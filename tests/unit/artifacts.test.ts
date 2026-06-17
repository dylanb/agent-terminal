// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createArtifacts } from '../../src/renderer/src/artifacts';
import type { ArtifactTree, ViewerFile } from '../../src/shared/ipc';

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

beforeEach(() => { document.body.replaceChildren(); });

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
    expect(v.renderCode).toHaveBeenCalledWith('body of src/a.ts', 'typescript', v.body());
    expect(v.title().textContent).toContain('a.ts');
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

  it('Send to agent and Add to todo route the viewer selection to the sinks', async () => {
    const v = mount();
    await v.api.refresh();
    v.setSelection('a passage');
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    (v.host.querySelector('.art-todo') as HTMLButtonElement).click();
    expect(v.send).toHaveBeenCalledWith('a passage');
    expect(v.addToTodo).toHaveBeenCalledWith('a passage');
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

  it('ArrowRight/Left on the separator nudges and persists the width', async () => {
    const onWidthChange = vi.fn();
    const v = mount(TREE_CURATED, { initialWidth: 248, onWidthChange });
    await v.api.refresh();
    v.divider().dispatchEvent(key('ArrowRight'));
    expect(v.width()).toBe('264px');
    expect(onWidthChange).toHaveBeenCalledWith(264);
  });
});
