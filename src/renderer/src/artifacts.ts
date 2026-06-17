// The artifact viewer (§20.1/§20.2 / §24.1): view 2's file tree + viewer. A placement-agnostic
// organism (UI-STANDARDS §1.2/§1.3) — it builds and touches only its host subtree, takes
// discovery (loadTree), file reading (loadFile), the heavy render stack, and the two §16.2
// sinks as injected seams, and themes through tokens only. The tree is hierarchical and
// provenance-tagged; in a repo a "show all repo files" checkbox switches the curated default
// to the whole repo (§20.1 / D8). Code renders read-only; a selection in either view routes
// to the same two sinks as the terminal-pane selection (send-to-agent / add-to-todo).

import type { ArtifactNode, ArtifactScope, ArtifactTree, ViewerFile } from '../../shared/ipc';

/** Render seams, sinks, and the discovery/read data sources — all injected (UI-STANDARDS §2.2). */
export interface ArtifactsDeps {
  /** Discover the current context's tree (real git/fs in production). */
  loadTree: (scope: ArtifactScope) => Promise<ArtifactTree>;
  /** Read one file by its tree-relative path; null when missing/binary/too large. */
  loadFile: (relPath: string) => Promise<ViewerFile | null>;
  /** Send the selection to the agent (inject, §9.3). */
  send: (text: string) => void;
  /** Add the selection to the repo-scoped todo list (§16.2). */
  addToTodo: (text: string) => void | Promise<void>;
  renderMarkdown?: (body: string, into: HTMLElement) => void;
  renderCode?: (body: string, lang: string | undefined, into: HTMLElement) => void;
  /** Current selection text within the viewer body (defaults to the live DOM selection). */
  readSelection?: (viewer: HTMLElement) => string;
  /** Persisted tree-pane width in px (§20.2); applied on load. */
  initialWidth?: number;
  /** Persist a new tree-pane width in px (debounced caller's concern). */
  onWidthChange?: (px: number) => void;
}

const DEFAULT_TREE_W = 248;
const MIN_TREE_W = 140;
const MAX_TREE_W = 640;
const WIDTH_STEP = 16;
const clampWidth = (px: number): number => Math.min(MAX_TREE_W, Math.max(MIN_TREE_W, Math.round(px)));

export interface Artifacts {
  /** Re-discover the tree (e.g. on a cwd change) and re-render. */
  refresh(): Promise<void>;
  open(relPath: string): Promise<void>;
  current(): string | null;
  /** Apply a tree-pane width without persisting (e.g. the persisted value once settings load). */
  setWidth(px: number): void;
  dispose(): void;
}

const plainInto = (body: string, into: HTMLElement): void => {
  into.replaceChildren();
  const pre = into.ownerDocument.createElement('pre');
  pre.textContent = body;
  into.appendChild(pre);
};

/** Selection text constrained to the viewer subtree, empty when the selection lies outside it. */
function selectionWithin(viewer: HTMLElement): string {
  const sel = viewer.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  const within = (n: Node | null): boolean => !!n && (n === viewer || viewer.contains(n));
  if (!within(sel.anchorNode) || !within(sel.focusNode)) return '';
  return sel.toString().trim();
}

/** First file (depth-first) in the tree, or null when there are none. */
function firstFile(nodes: ArtifactNode[]): ArtifactNode | null {
  for (const n of nodes) {
    if (n.kind === 'file') return n;
    if (n.children) {
      const f = firstFile(n.children);
      if (f) return f;
    }
  }
  return null;
}

export function createArtifacts(host: HTMLElement, deps: ArtifactsDeps): Artifacts {
  const doc = host.ownerDocument;
  const renderMarkdown = deps.renderMarkdown ?? plainInto;
  const renderCode = deps.renderCode ?? ((b, _l, into) => plainInto(b, into));
  const readSelection = deps.readSelection ?? selectionWithin;

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  // --- DOM: tree | viewer (the organism owns this whole subtree) ---
  host.replaceChildren();
  const split = el('div', 'artsplit');
  const tree = el('div', 'tree');
  const search = doc.createElement('input');
  search.className = 'treesearch';
  search.type = 'search';
  search.placeholder = 'Filter files';
  search.setAttribute('aria-label', 'Filter files');
  const scopeLabel = doc.createElement('label');
  scopeLabel.className = 'scope-toggle';
  const scopeBox = doc.createElement('input');
  scopeBox.type = 'checkbox';
  scopeLabel.append(scopeBox, doc.createTextNode(' Show all repo files'));
  const list = el('div', 'treelist');
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', 'Artifacts');
  tree.append(search, scopeLabel, list);

  // Drag/keyboard-resizable edge between the tree and the viewer (§20.2).
  const divider = el('div', 'artsplit-divider');
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Resize file tree');
  divider.tabIndex = 0;

  const viewer = el('div', 'viewer');
  const bar = el('div', 'vbar');
  const title = el('div', 'vtitle serif');
  const meta = el('div', 'vmeta');
  const actions = el('div', 'vactions');
  const sendBtn = el('button', 'art-send pill sm signal', 'Send to agent') as HTMLButtonElement;
  const todoBtn = el('button', 'art-todo pill sm', 'Add to todo') as HTMLButtonElement;
  actions.append(sendBtn, todoBtn);
  const titleWrap = el('div', 'vtitlewrap');
  titleWrap.append(title, meta);
  bar.append(titleWrap, actions);
  const body = el('div', 'vbody');
  viewer.append(bar, body);

  split.append(tree, divider, viewer);
  host.appendChild(split);

  let scope: ArtifactScope = 'curated';
  let current: string | null = null;
  let treeRoot = '';
  let refreshSeq = 0; // a slow stale refresh must not overwrite a newer one (cwd sync race)
  const fileRows = new Map<string, HTMLElement>();

  // --- Resizable tree pane (§20.2): drag the divider, or arrow-key it; width persists. ---
  let width = clampWidth(deps.initialWidth ?? DEFAULT_TREE_W);
  function applyWidth(px: number, persist: boolean): void {
    width = clampWidth(px);
    split.style.setProperty('--tree-w', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    if (persist) deps.onWidthChange?.(width);
  }
  applyWidth(width, false);
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = (e as MouseEvent).clientX;
    const startW = width;
    const onMove = (ev: MouseEvent): void => applyWidth(startW + (ev.clientX - startX), false);
    const onUp = (): void => {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      deps.onWidthChange?.(width); // persist once at gesture end
    };
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') applyWidth(width - WIDTH_STEP, true);
    else if (e.key === 'ArrowRight') applyWidth(width + WIDTH_STEP, true);
    else return;
    e.preventDefault();
  });
  divider.addEventListener('dblclick', () => applyWidth(DEFAULT_TREE_W, true));
  // A button click collapses the live DOM selection before its handler runs, so we remember
  // the last non-empty in-viewer selection and fall back to it at click time.
  let lastSelection = '';
  const onSelectionChange = (): void => {
    const text = readSelection(body);
    if (text) lastSelection = text;
  };
  doc.addEventListener('selectionchange', onSelectionChange);

  const PROV_LABEL: Record<string, string> = { changed: 'changed', loop: 'loop', pr: 'PR' };

  function renderNodes(nodes: ArtifactNode[], into: HTMLElement): void {
    for (const node of nodes) {
      if (node.kind === 'dir') {
        const dir = el('div', 'dir');
        const head = el('div', 'dname', node.name);
        head.title = node.relPath; // full path on hover (§20.2 truncation discoverability)
        head.setAttribute('role', 'treeitem');
        head.tabIndex = -1;
        head.addEventListener('click', () => dir.classList.toggle('collapsed'));
        const children = el('div', 'dchildren');
        renderNodes(node.children ?? [], children);
        dir.append(head, children);
        into.appendChild(dir);
      } else {
        const row = el('div', 'f');
        row.dataset.rel = node.relPath;
        row.title = node.relPath; // full path on hover, since the name truncates (§20.2)
        row.setAttribute('role', 'treeitem');
        row.tabIndex = -1;
        row.append(el('span', 'ic', node.relPath.endsWith('.md') ? 'md' : 'ƒ'), el('span', 'fn', node.name));
        for (const p of node.provenance ?? []) row.appendChild(el('span', `tag tag-${p}`, PROV_LABEL[p] ?? p));
        row.addEventListener('click', () => void open(node.relPath));
        fileRows.set(node.relPath, row);
        into.appendChild(row);
      }
    }
  }

  /** Visible treeitems in DOM order — a row inside a collapsed directory is skipped (§20.1). */
  function visibleItems(): HTMLElement[] {
    return ([...list.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).filter((row) => {
      for (let p = row.parentElement; p && p !== list; p = p.parentElement) {
        if (p.classList.contains('dchildren') && p.parentElement?.classList.contains('collapsed')) return false;
      }
      return true;
    });
  }

  function focusItem(row: HTMLElement | undefined): void {
    if (!row) return;
    for (const r of list.querySelectorAll('[role="treeitem"]')) (r as HTMLElement).tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
  }

  // WAI-ARIA tree keyboard nav (§20.2): a single handler on the tree, keyed off the focused row.
  list.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest('[role="treeitem"]') as HTMLElement | null;
    if (!row) return;
    const items = visibleItems();
    const i = items.indexOf(row);
    const isDir = row.classList.contains('dname');
    const dir = row.parentElement; // the .dir wrapper, for dir rows
    switch (e.key) {
      case 'ArrowDown': focusItem(items[i + 1]); break;
      case 'ArrowUp': focusItem(items[i - 1]); break;
      case 'Home': focusItem(items[0]); break;
      case 'End': focusItem(items[items.length - 1]); break;
      case 'Enter':
      case ' ':
        if (isDir) dir?.classList.toggle('collapsed');
        else void open(row.dataset.rel!);
        break;
      case 'ArrowRight':
        if (isDir && dir?.classList.contains('collapsed')) dir.classList.remove('collapsed');
        else if (isDir) focusItem(visibleItems()[i + 1]); // into first child
        break;
      case 'ArrowLeft':
        if (isDir && !dir?.classList.contains('collapsed')) dir?.classList.add('collapsed');
        else focusItem(row.closest('.dchildren')?.parentElement?.querySelector(':scope > .dname') as HTMLElement);
        break;
      default: return;
    }
    e.preventDefault();
  });

  function applyFilter(): void {
    const q = search.value.trim().toLowerCase();
    for (const [rel, row] of fileRows) row.hidden = q.length > 0 && !rel.toLowerCase().includes(q);
    // A directory with no visible file collapses out of the way; expand all while filtering.
    for (const dir of list.querySelectorAll('.dir')) {
      const anyVisible = [...dir.querySelectorAll('.f')].some((f) => !(f as HTMLElement).hidden);
      (dir as HTMLElement).hidden = q.length > 0 && !anyVisible;
      if (q.length > 0) dir.classList.remove('collapsed');
    }
  }

  async function open(relPath: string): Promise<void> {
    current = relPath;
    lastSelection = '';
    for (const [rel, row] of fileRows) row.classList.toggle('sel', rel === relPath);
    const file = await deps.loadFile(relPath);
    if (current !== relPath) return; // a newer open won the race
    if (!file) {
      title.textContent = relPath;
      meta.textContent = 'Cannot display this file';
      plainInto('', body);
      return;
    }
    title.textContent = file.name;
    meta.textContent = file.relPath;
    if (file.kind === 'code') renderCode(file.body, file.lang, body);
    else renderMarkdown(file.body, body);
  }

  async function refresh(): Promise<void> {
    const token = ++refreshSeq;
    const data = await deps.loadTree(scope);
    if (token !== refreshSeq) return; // a newer refresh started while we awaited
    treeRoot = data.root;
    scope = data.scope;
    scopeBox.checked = scope === 'repo';
    scopeLabel.hidden = !data.isRepo; // outside a repo the tree is already the whole dir
    fileRows.clear();
    list.replaceChildren();
    renderNodes(data.nodes, list);
    applyFilter();
    const firstItem = visibleItems()[0]; // one row carries tabindex=0 so the tree is reachable
    if (firstItem) firstItem.tabIndex = 0;
    const target = (current && fileRows.has(current) ? current : firstFile(data.nodes)?.relPath) ?? null;
    if (target) await open(target);
    else {
      current = null;
      title.textContent = treeRoot ? 'No artifacts' : '';
      meta.textContent = '';
      plainInto('', body);
    }
  }

  function routeSelection(sink: (text: string) => void | Promise<void>): void {
    const text = readSelection(body) || lastSelection;
    if (!text) return;
    void sink(text);
  }

  sendBtn.addEventListener('click', () => routeSelection(deps.send));
  todoBtn.addEventListener('click', () => routeSelection(deps.addToTodo));
  search.addEventListener('input', applyFilter);
  scopeBox.addEventListener('change', () => {
    scope = scopeBox.checked ? 'repo' : 'curated';
    void refresh();
  });

  void refresh();

  return {
    refresh,
    open,
    current: () => current,
    setWidth: (px) => applyWidth(px, false),
    dispose: () => {
      doc.removeEventListener('selectionchange', onSelectionChange);
      host.replaceChildren();
    },
  };
}
