// The artifact viewer (§20.1/§20.2 / §24.1): view 2's file tree + viewer. A placement-agnostic
// organism (UI-STANDARDS §1.2/§1.3) — it builds and touches only its host subtree, takes
// discovery (loadTree), file reading (loadFile), the heavy render stack, and the two §16.2
// sinks as injected seams, and themes through tokens only. The tree is hierarchical and
// provenance-tagged; in a repo a "show all repo files" checkbox switches the curated default
// to the whole repo (§20.1 / D8). Code renders read-only; a selection in either view routes
// to the same two sinks as the terminal-pane selection (send-to-agent / add-to-todo).

import type { ArtifactNode, ArtifactScope, ArtifactTree, ViewerFile } from '../../shared/ipc';
import { setShown, setCollapsed } from './visibility';

/** Handle on a rendered code view, used to drive changed-section navigation (§20.2). */
export interface CodeView {
  /** Scroll the editor so 1-based `line` is in view. */
  revealLine(line: number): void;
  /** 1-based inclusive line range currently visible in the viewport. */
  visibleLines(): { top: number; bottom: number };
  /** Subscribe to viewport changes (scroll/resize); returns an unsubscribe. */
  onViewportChange(listener: () => void): () => void;
  /** Release the underlying editor's document/window handlers on unmount (§20.2). Removing the
   *  DOM alone does not free them, so the organism calls this in dispose(). Optional so a trivial
   *  text-only renderCode fallback need not implement it. */
  destroy?(): void;
}

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
  renderCode?: (body: string, lang: string | undefined, into: HTMLElement, changedLines?: number[]) => CodeView | void;
  /** Current selection text within the viewer body (defaults to the live DOM selection). */
  readSelection?: (viewer: HTMLElement) => string;
  /** Persisted tree-pane width in px (§20.2); applied on load. */
  initialWidth?: number;
  /** Persist a new tree-pane width in px (debounced caller's concern). */
  onWidthChange?: (px: number) => void;
  /** Persisted full-screen tree-popout width in px (§20.2); when absent it defaults to 30% of the viewport. */
  initialFullscreenWidth?: number;
  /** Persist a new full-screen tree-popout width in px. */
  onFullscreenWidthChange?: (px: number) => void;
  /** Ask the app shell to enter/exit viewer full screen (§20.2); the shell calls setFullscreen back. */
  onRequestFullscreen?: (on: boolean) => void;
}

const DEFAULT_TREE_W = 248;
const MIN_TREE_W = 140;
const MAX_TREE_W = 640;
const WIDTH_STEP = 16;
const FS_MIN_TREE_W = 200; // full-screen popout floor; ceiling is FS_MAX_VIEWPORT_FRAC of the viewport
const FS_MAX_VIEWPORT_FRAC = 0.85;
const clampWidth = (px: number): number => Math.min(MAX_TREE_W, Math.max(MIN_TREE_W, Math.round(px)));

export interface Artifacts {
  /** Re-discover the tree (e.g. on a cwd change) and re-render. */
  refresh(): Promise<void>;
  open(relPath: string): Promise<void>;
  current(): string | null;
  /** Apply a tree-pane width without persisting (e.g. the persisted value once settings load). */
  setWidth(px: number): void;
  /** Apply a persisted full-screen popout width without persisting (§20.2). */
  setFullscreenWidth(px: number): void;
  /** Reflect viewer full-screen state (§20.2); driven by the shell, never emits back. */
  setFullscreen(on: boolean): void;
  isFullscreen(): boolean;
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
  sendBtn.disabled = true; // inert until there is a highlight to act on (§20.2)
  todoBtn.disabled = true;
  // The sinks act on the live selection, which a button mousedown would otherwise collapse;
  // preventDefault keeps it alive across the click so the handler still sees it (§20.2).
  for (const b of [sendBtn, todoBtn]) b.addEventListener('mousedown', (e) => e.preventDefault());
  // Step through the file's changed sections (§20.2), with a current/total readout.
  const prevBtn = el('button', 'art-prev pill sm', '‹') as HTMLButtonElement;
  const nextBtn = el('button', 'art-next pill sm', '›') as HTMLButtonElement;
  prevBtn.setAttribute('aria-label', 'Previous changed section');
  nextBtn.setAttribute('aria-label', 'Next changed section');
  const navCount = el('span', 'art-navcount');
  const nav = el('div', 'vnav');
  setShown(nav, false);
  nav.append(prevBtn, navCount, nextBtn);
  // Full-screen toggle (§20.2): the same button enters and exits; in full screen it lives in the
  // revealed header (the "top bar when visible") and Escape is the other exit.
  const fsBtn = el('button', 'art-fs pill sm', '⛶') as HTMLButtonElement;
  fsBtn.setAttribute('aria-label', 'Full screen');
  fsBtn.setAttribute('aria-pressed', 'false');
  actions.append(sendBtn, todoBtn, nav, fsBtn);
  const titleWrap = el('div', 'vtitlewrap');
  titleWrap.append(title, meta);
  bar.append(titleWrap, actions);
  const body = el('div', 'vbody');
  body.setAttribute('role', 'region'); // a labelled, keyboard-focusable scroll region (§20.2 a11y)
  viewer.append(bar, body);

  // Thin edge strips that pop the collapsed header/tree open and closed in full screen (§20.2);
  // hidden by CSS outside full screen. Real buttons → Tab-reachable, Enter/Space-operable.
  const topStrip = el('button', 'fs-strip fs-strip-top') as HTMLButtonElement;
  topStrip.setAttribute('aria-label', 'Show file header');
  topStrip.setAttribute('aria-expanded', 'false');
  const leftStrip = el('button', 'fs-strip fs-strip-left') as HTMLButtonElement;
  leftStrip.setAttribute('aria-label', 'Show file tree');
  leftStrip.setAttribute('aria-expanded', 'false');
  // Resize handle on the full-screen tree popout's right edge (§20.2); drag or arrow-key.
  const fsResize = el('div', 'fs-tree-resize');
  fsResize.setAttribute('role', 'separator');
  fsResize.setAttribute('aria-orientation', 'vertical');
  fsResize.setAttribute('aria-label', 'Resize file tree');
  fsResize.tabIndex = 0;
  split.append(tree, divider, viewer, topStrip, leftStrip, fsResize);
  host.appendChild(split);

  let scope: ArtifactScope = 'curated';
  let current: string | null = null;
  let treeRoot = '';
  let treeNodes: ArtifactNode[] = []; // the full discovered tree; the search re-renders a filtered view of it
  let refreshSeq = 0; // a slow stale refresh must not overwrite a newer one (cwd sync race)
  const fileRows = new Map<string, HTMLElement>();

  // --- Resizable tree pane (§20.2): drag the divider, or arrow-key it; width persists. ---
  let width = clampWidth(deps.initialWidth ?? DEFAULT_TREE_W);
  function applyWidth(px: number, persist: boolean): void {
    width = clampWidth(px);
    split.style.setProperty('--tree-w', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuemin', String(MIN_TREE_W)); // expose the clamp range for AT (§20.2)
    divider.setAttribute('aria-valuemax', String(MAX_TREE_W));
    if (persist) deps.onWidthChange?.(width);
  }
  applyWidth(width, false);

  // A drag attaches document-level mousemove/mouseup; tracked in one outer slot so a mid-gesture
  // dispose() (relocation/unmount) removes them deterministically and a new drag can't stack (§20.2).
  let endDrag: (() => void) | null = null;
  function beginDrag(startX: number, startW: number, apply: (px: number) => void, persist: () => void): void {
    endDrag?.();
    const onMove = (ev: MouseEvent): void => apply(startW + (ev.clientX - startX));
    const onUp = (): void => {
      endDrag?.();
      persist();
    };
    endDrag = (): void => {
      doc.removeEventListener('mousemove', onMove);
      doc.removeEventListener('mouseup', onUp);
      endDrag = null;
    };
    doc.addEventListener('mousemove', onMove);
    doc.addEventListener('mouseup', onUp);
  }

  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    beginDrag((e as MouseEvent).clientX, width, (px) => applyWidth(px, false), () => deps.onWidthChange?.(width));
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') applyWidth(width - WIDTH_STEP, true);
    else if (e.key === 'ArrowRight') applyWidth(width + WIDTH_STEP, true);
    else return;
    e.preventDefault();
  });

  // --- Full-screen tree popout: its own remembered width, defaulting to 30% of the viewport so it
  // opens usefully wide; resized by dragging its right edge or arrow-keying it (§20.2). ---
  const viewportW = (): number => doc.defaultView?.innerWidth ?? 1024;
  const fsMaxWidth = (): number => Math.round(viewportW() * FS_MAX_VIEWPORT_FRAC);
  const clampFsWidth = (px: number): number => Math.min(fsMaxWidth(), Math.max(FS_MIN_TREE_W, Math.round(px)));
  let fsWidth = clampFsWidth(deps.initialFullscreenWidth ?? Math.ceil(viewportW() * 0.3));
  function applyFsWidth(px: number, persist: boolean): void {
    fsWidth = clampFsWidth(px);
    split.style.setProperty('--tree-w-fs', `${fsWidth}px`);
    fsResize.setAttribute('aria-valuenow', String(fsWidth));
    fsResize.setAttribute('aria-valuemin', String(FS_MIN_TREE_W)); // clamp range for AT (§20.2)
    fsResize.setAttribute('aria-valuemax', String(fsMaxWidth())); // viewport-dependent ceiling
    if (persist) deps.onFullscreenWidthChange?.(fsWidth);
  }
  applyFsWidth(fsWidth, false);
  // The clamp ceiling (aria-valuemax) is viewport-dependent, so re-apply on window resize to keep
  // it (and the width) from going stale; cleaned up in dispose().
  const win = doc.defaultView;
  const onWindowResize = (): void => applyFsWidth(fsWidth, false);
  win?.addEventListener('resize', onWindowResize);
  fsResize.addEventListener('mousedown', (e) => {
    e.preventDefault();
    beginDrag((e as MouseEvent).clientX, fsWidth, (px) => applyFsWidth(px, false), () => deps.onFullscreenWidthChange?.(fsWidth));
  });
  fsResize.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') applyFsWidth(fsWidth - WIDTH_STEP, true);
    else if (e.key === 'ArrowRight') applyFsWidth(fsWidth + WIDTH_STEP, true);
    else return;
    e.preventDefault();
  });
  divider.addEventListener('dblclick', () => applyWidth(DEFAULT_TREE_W, true));
  // A button click collapses the live DOM selection before its handler runs, so we remember
  // the last non-empty in-viewer selection and fall back to it at click time.
  let lastSelection = '';
  function updateActions(): void {
    const text = readSelection(body);
    if (text) lastSelection = text;
    sendBtn.disabled = text.length === 0;
    todoBtn.disabled = text.length === 0;
  }
  doc.addEventListener('selectionchange', updateActions);

  // --- Changed-section navigation (§20.2): viewport-driven. `sections` is the 1-based start
  // line of each contiguous changed run; the readout and prev/next targets are read off what
  // the editor currently shows, so scrolling updates them live. ---
  let codeView: CodeView | null = null;
  let sections: number[] = [];
  let unsubViewport: (() => void) | null = null;
  function changedSections(lines?: number[]): number[] {
    if (!lines || lines.length === 0) return [];
    const sorted = [...lines].sort((a, b) => a - b);
    const starts: number[] = [];
    let prev = Number.NEGATIVE_INFINITY;
    for (const n of sorted) {
      if (n !== prev + 1) starts.push(n);
      prev = n;
    }
    return starts;
  }
  // Current = the last section scrolled onto/past the screen (≤ viewport bottom); prev/next
  // target the nearest section strictly above the top / below the bottom of the viewport.
  function navState(): { display: number; prevTo: number | null; nextTo: number | null } {
    if (!codeView || sections.length === 0) return { display: 0, prevTo: null, nextTo: null };
    const { top, bottom } = codeView.visibleLines();
    let cur = -1;
    let prevTo: number | null = null;
    let nextTo: number | null = null;
    for (let i = 0; i < sections.length; i++) {
      if (sections[i] <= bottom) cur = i;
      if (sections[i] < top) prevTo = sections[i];
      if (nextTo === null && sections[i] > bottom) nextTo = sections[i];
    }
    return { display: Math.max(cur, 0) + 1, prevTo, nextTo };
  }
  function updateNav(): void {
    const shown = codeView !== null && sections.length > 0;
    setShown(nav, shown);
    if (!shown) return;
    const s = navState();
    navCount.textContent = `${s.display} / ${sections.length}`;
    prevBtn.disabled = s.prevTo === null;
    nextBtn.disabled = s.nextTo === null;
  }
  prevBtn.addEventListener('click', () => {
    const { prevTo } = navState();
    if (prevTo !== null) codeView?.revealLine(prevTo);
  });
  nextBtn.addEventListener('click', () => {
    const { nextTo } = navState();
    if (nextTo !== null) codeView?.revealLine(nextTo);
  });

  // --- Full-screen viewer (§20.2): the button requests the chrome change through the contract;
  // the shell calls setFullscreen back. The header/tree slide off and the edge strips pop them
  // open and closed. State lives on the .artsplit element so the styling is placement-agnostic. ---
  let fullscreen = false;
  fsBtn.addEventListener('click', () => deps.onRequestFullscreen?.(!fullscreen));
  // Each panel's open state lives as .is-collapsed on the panel itself, so a collapsed (slid-off)
  // header/tree is inert — no tab stops inside hidden content (§22.2).
  const setHeaderOpen = (open: boolean): void => {
    setCollapsed(bar, !open);
    topStrip.setAttribute('aria-expanded', String(open));
  };
  const setTreeOpen = (open: boolean): void => {
    setCollapsed(tree, !open);
    leftStrip.setAttribute('aria-expanded', String(open));
  };
  topStrip.addEventListener('click', () => setHeaderOpen(bar.classList.contains('is-collapsed')));
  leftStrip.addEventListener('click', () => setTreeOpen(tree.classList.contains('is-collapsed')));
  function setFullscreen(on: boolean): void {
    if (on === fullscreen) return;
    fullscreen = on;
    split.classList.toggle('fullscreen', on);
    setHeaderOpen(!on); // collapsed on enter; expanded on exit so the normal split shows them again
    setTreeOpen(!on);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    (on ? topStrip : fsBtn).focus(); // keep keyboard focus on a live control across the transition
  }

  const PROV_LABEL: Record<string, string> = { changed: 'changed', loop: 'loop', pr: 'PR' };

  // Collapse/expand a directory and keep its treeitem's aria-expanded in sync (§20.2 a11y).
  const setDirCollapsed = (dir: HTMLElement, head: HTMLElement, collapsed: boolean): void => {
    dir.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
  };

  function renderNodes(nodes: ArtifactNode[], into: HTMLElement): void {
    for (const node of nodes) {
      if (node.kind === 'dir') {
        const dir = el('div', 'dir');
        const head = el('div', 'dname', node.name);
        head.title = node.relPath; // full path on hover (§20.2 truncation discoverability)
        head.setAttribute('role', 'treeitem');
        head.setAttribute('aria-expanded', 'true'); // dirs render expanded; kept in sync on toggle
        head.tabIndex = -1;
        head.addEventListener('click', () => setDirCollapsed(dir, head, !dir.classList.contains('collapsed')));
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
        if (isDir && dir) setDirCollapsed(dir, row, !dir.classList.contains('collapsed'));
        else void open(row.dataset.rel!);
        break;
      case 'ArrowRight':
        if (isDir && dir?.classList.contains('collapsed')) setDirCollapsed(dir, row, false);
        else if (isDir) focusItem(visibleItems()[i + 1]); // into first child
        break;
      case 'ArrowLeft':
        if (isDir && dir && !dir.classList.contains('collapsed')) setDirCollapsed(dir, row, true);
        else focusItem(row.closest('.dchildren')?.parentElement?.querySelector(':scope > .dname') as HTMLElement);
        break;
      default: return;
    }
    e.preventDefault();
  });

  // Keep a file iff its own name matches (not its path — else a directory whose name contains the
  // query would drag in all its files); keep a directory iff it still has a matching descendant, so
  // matches show with just their tree hierarchy (§20.2).
  function filterNodes(nodes: ArtifactNode[], q: string): ArtifactNode[] {
    const out: ArtifactNode[] = [];
    for (const n of nodes) {
      if (n.kind === 'dir') {
        const kids = filterNodes(n.children ?? [], q);
        if (kids.length) out.push({ ...n, children: kids });
      } else if (n.name.toLowerCase().includes(q)) {
        out.push(n);
      }
    }
    return out;
  }

  // Render the tree from the discovered nodes, filtered to the current query — we re-render rather
  // than toggle visibility so nothing non-matching is ever in the DOM (§20.2).
  function renderTree(): void {
    const q = search.value.trim().toLowerCase();
    fileRows.clear();
    list.replaceChildren();
    renderNodes(q ? filterNodes(treeNodes, q) : treeNodes, list);
    if (current) fileRows.get(current)?.classList.add('sel');
    const firstItem = visibleItems()[0]; // one row carries tabindex=0 so the tree is reachable
    if (firstItem) firstItem.tabIndex = 0;
  }

  async function open(relPath: string): Promise<void> {
    current = relPath;
    lastSelection = '';
    for (const [rel, row] of fileRows) row.classList.toggle('sel', rel === relPath);
    // An IPC failure (e.g. main restart) reads as an unreadable file, not an unhandled
    // rejection — the `if (!file)` path below renders the "Cannot display" state (§20.2).
    let file: ViewerFile | null;
    try {
      file = await deps.loadFile(relPath);
    } catch {
      file = null;
    }
    if (current !== relPath) return; // a newer open won the race
    body.setAttribute('aria-label', file?.name ?? relPath);
    if (!file) {
      title.textContent = relPath;
      meta.textContent = 'Cannot display this file';
      body.tabIndex = 0;
      plainInto('', body);
      return;
    }
    title.textContent = file.name;
    meta.textContent = file.relPath;
    unsubViewport?.();
    unsubViewport = null;
    codeView = null;
    if (file.kind === 'code') {
      // The editor owns its own scroller (cm-scroller, focusable in viewerRender) — so the body
      // steps out of the tab order to avoid a dead, unscrollable stop (§20.2 a11y).
      body.tabIndex = -1;
      codeView = renderCode(file.body, file.lang, body, file.changedLines) ?? null;
      sections = changedSections(file.changedLines);
      if (codeView) unsubViewport = codeView.onViewportChange(updateNav);
    } else {
      body.tabIndex = 0; // the body itself scrolls markdown → make it the focusable scroll region
      renderMarkdown(file.body, body);
      sections = [];
    }
    updateNav();
    updateActions();
  }

  async function refresh(): Promise<void> {
    const token = ++refreshSeq;
    // Leave the previous tree/content in place on an IPC failure rather than blanking the
    // viewer or surfacing an unhandled rejection (callers use `void refresh()`, §20.2).
    let data: ArtifactTree;
    try {
      data = await deps.loadTree(scope);
    } catch {
      return;
    }
    if (token !== refreshSeq) return; // a newer refresh started while we awaited
    treeRoot = data.root;
    scope = data.scope;
    scopeBox.checked = scope === 'repo';
    scopeLabel.hidden = !data.isRepo; // outside a repo the tree is already the whole dir
    treeNodes = data.nodes;
    renderTree();
    const target = (current && fileRows.has(current) ? current : firstFile(data.nodes)?.relPath) ?? null;
    if (target) await open(target);
    else {
      current = null;
      title.textContent = treeRoot ? 'No artifacts' : '';
      meta.textContent = '';
      body.tabIndex = 0;
      plainInto('', body);
    }
  }

  function routeSelection(sink: (text: string) => void | Promise<void>): void {
    const text = readSelection(body) || lastSelection;
    if (!text) return;
    // The sink may be async (addToTodo crosses IPC); a rejected invoke (main restart) must not
    // become an unhandled renderer rejection.
    Promise.resolve(sink(text)).catch(() => {});
  }

  sendBtn.addEventListener('click', () => routeSelection(deps.send));
  todoBtn.addEventListener('click', () => routeSelection(deps.addToTodo));
  search.addEventListener('input', renderTree);
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
    setFullscreenWidth: (px) => applyFsWidth(px, false),
    setFullscreen,
    isFullscreen: () => fullscreen,
    dispose: () => {
      doc.removeEventListener('selectionchange', updateActions);
      win?.removeEventListener('resize', onWindowResize);
      endDrag?.(); // remove any document-level listeners from an in-flight resize drag (§20.2)
      unsubViewport?.();
      codeView?.destroy?.(); // free CodeMirror's handlers — DOM removal alone doesn't (§20.2)
      host.replaceChildren();
    },
  };
}
