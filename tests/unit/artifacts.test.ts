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
  };
}

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

  it('does nothing when there is no selection to send', async () => {
    const v = mount();
    await v.api.refresh();
    v.setSelection('');
    (v.host.querySelector('.art-send') as HTMLButtonElement).click();
    expect(v.send).not.toHaveBeenCalled();
  });
});
