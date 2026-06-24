// The artifact viewer (§20.1/§20.2 / §24.1): view 2's file tree + viewer. A placement-agnostic
// organism (UI-STANDARDS §1.2/§1.3). A selection in either view routes to the same two §16.2 sinks
// as the terminal-pane selection (send-to-agent / add-to-todo).

import type { ArtifactNode, ArtifactScope, ArtifactTree, ViewerFile } from '../../shared/ipc';
import { setShown, setCollapsed } from './visibility';
import { FOCUS_VIEW_EVENT } from './paneActions';

/** The artifact viewer is view 2 in the converged shell (§22.4 / §24.1C). */
const ARTIFACTS_VIEW = '2';

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
const FS_MIN_TREE_W = 200;
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
export function selectionWithin(viewer: HTMLElement): string {
  const sel = viewer.ownerDocument.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return '';
  const within = (n: Node | null): boolean => !!n && (n === viewer || viewer.contains(n));
  if (!within(sel.anchorNode) || !within(sel.focusNode)) return '';
  // RAW selection so code indentation/trailing newlines survive (§16.2); a whitespace-only
  // selection collapses to empty so the disabled-until-highlight guard holds.
  const text = sel.toString();
  return text.trim() === '' ? '' : text;
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
  sendBtn.disabled = true;
  todoBtn.disabled = true;
  // preventDefault keeps the live selection alive across the click — a button mousedown would
  // otherwise collapse it before the sink handler reads it (§20.2).
  for (const b of [sendBtn, todoBtn]) b.addEventListener('mousedown', (e) => e.preventDefault());
  const prevBtn = el('button', 'art-prev pill sm', '‹') as HTMLButtonElement;
  const nextBtn = el('button', 'art-next pill sm', '›') as HTMLButtonElement;
  prevBtn.setAttribute('aria-label', 'Previous changed section');
  nextBtn.setAttribute('aria-label', 'Next changed section');
  const navCount = el('span', 'art-navcount');
  const nav = el('div', 'vnav');
  setShown(nav, false);
  nav.append(prevBtn, navCount, nextBtn);
  // Full-screen toggle (§20.2).
  const fsBtn = el('button', 'art-fs pill sm', '⛶') as HTMLButtonElement;
  fsBtn.setAttribute('aria-label', 'Full screen');
  fsBtn.setAttribute('aria-pressed', 'false');
  actions.append(sendBtn, todoBtn, nav, fsBtn);
  const titleWrap = el('div', 'vtitlewrap');
  titleWrap.append(title, meta);
  bar.append(titleWrap, actions);
  const body = el('div', 'vbody');
  body.setAttribute('role', 'region'); // §20.2 a11y
  viewer.append(bar, body);

  // Edge strips that reopen the collapsed header/tree in full screen (§20.2); real <button>s so
  // they are Tab-reachable and Enter/Space-operable, not click-only divs.
  const topStrip = el('button', 'fs-strip fs-strip-top') as HTMLButtonElement;
  topStrip.setAttribute('aria-label', 'Show file header');
  topStrip.setAttribute('aria-expanded', 'false');
  const leftStrip = el('button', 'fs-strip fs-strip-left') as HTMLButtonElement;
  leftStrip.setAttribute('aria-label', 'Show file tree');
  leftStrip.setAttribute('aria-expanded', 'false');
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
  let treeNodes: ArtifactNode[] = [];
  let refreshSeq = 0; // a slow stale refresh must not overwrite a newer one (cwd sync race)
  let renderedTreeSig: string | null = null; // last rendered tree structure; a live reload that matches skips the rebuild
  let shownSig: string | null = null; // last rendered file content; an unchanged reload keeps the view (and its scroll)
  const fileRows = new Map<string, HTMLElement>();

  let width = clampWidth(deps.initialWidth ?? DEFAULT_TREE_W);
  function applyWidth(px: number, persist: boolean): void {
    width = clampWidth(px);
    split.style.setProperty('--tree-w', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuemin', String(MIN_TREE_W)); // §20.2 a11y
    divider.setAttribute('aria-valuemax', String(MAX_TREE_W));
    if (persist) deps.onWidthChange?.(width);
  }
  applyWidth(width, false);

  // The drag's document-level listeners live in one outer slot so a mid-gesture dispose() removes
  // them deterministically and a new drag can't stack a second pair (§20.2).
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

  // The full-screen popout keeps its own width, defaulting to 30% of the viewport so it opens
  // usefully wide (§20.2).
  const viewportW = (): number => doc.defaultView?.innerWidth ?? 1024;
  const fsMaxWidth = (): number => Math.round(viewportW() * FS_MAX_VIEWPORT_FRAC);
  const clampFsWidth = (px: number): number => Math.min(fsMaxWidth(), Math.max(FS_MIN_TREE_W, Math.round(px)));
  let fsWidth = clampFsWidth(deps.initialFullscreenWidth ?? Math.ceil(viewportW() * 0.3));
  function applyFsWidth(px: number, persist: boolean): void {
    fsWidth = clampFsWidth(px);
    split.style.setProperty('--tree-w-fs', `${fsWidth}px`);
    fsResize.setAttribute('aria-valuenow', String(fsWidth));
    fsResize.setAttribute('aria-valuemin', String(FS_MIN_TREE_W)); // §20.2 a11y
    fsResize.setAttribute('aria-valuemax', String(fsMaxWidth())); // viewport-dependent ceiling
    if (persist) deps.onFullscreenWidthChange?.(fsWidth);
  }
  applyFsWidth(fsWidth, false);
  // The clamp ceiling is viewport-dependent, so re-apply on window resize to keep it (and the
  // width) from going stale.
  const win = doc.defaultView;
  const onWindowResize = (): void => applyFsWidth(fsWidth, false);
  win?.addEventListener('resize', onWindowResize);

  // §22.4 focus rule: the shell dispatches FOCUS_VIEW_EVENT when it switches view; on our view we
  // move focus to the first tree item (the view's primary control) so arrow-nav works without a click.
  const onFocusView = (e: Event): void => {
    if ((e as CustomEvent<{ view: string }>).detail?.view === ARTIFACTS_VIEW) focusItem(visibleItems()[0]);
  };
  win?.addEventListener(FOCUS_VIEW_EVENT, onFocusView);
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
  // Fallback for the sinks: a click can collapse the live selection before the handler reads it,
  // so the last non-empty in-viewer selection is remembered.
  let lastSelection = '';
  function updateActions(): void {
    const text = readSelection(body);
    if (text) lastSelection = text;
    sendBtn.disabled = text.length === 0;
    todoBtn.disabled = text.length === 0;
  }
  doc.addEventListener('selectionchange', updateActions);

  // Changed-section navigation (§20.2): the readout and prev/next targets are read off the
  // editor's current viewport, so scrolling updates them live.
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

  // Full-screen viewer (§20.2): the button requests the chrome change through the contract and
  // the shell calls setFullscreen back. State lives on .artsplit so the styling is placement-agnostic.
  let fullscreen = false;
  fsBtn.addEventListener('click', () => deps.onRequestFullscreen?.(!fullscreen));
  // .is-collapsed on the panel itself keeps a slid-off header/tree inert — no tab stops inside
  // hidden content (§22.2).
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
    setHeaderOpen(!on);
    setTreeOpen(!on);
    fsBtn.setAttribute('aria-pressed', String(on));
    fsBtn.setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    (on ? topStrip : fsBtn).focus(); // keep focus on a live control across the transition (WCAG 2.4.3)
  }

  const PROV_LABEL: Record<string, string> = { changed: 'changed', loop: 'loop', pr: 'PR' };

  // Keep the treeitem's aria-expanded in sync with the collapse state (§20.2 a11y).
  const setDirCollapsed = (dir: HTMLElement, head: HTMLElement, collapsed: boolean): void => {
    dir.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
  };

  function renderNodes(nodes: ArtifactNode[], into: HTMLElement): void {
    for (const node of nodes) {
      if (node.kind === 'dir') {
        const dir = el('div', 'dir');
        const head = el('div', 'dname', node.name);
        head.title = node.relPath; // truncated name → full path on hover (§20.2)
        head.setAttribute('role', 'treeitem');
        head.setAttribute('aria-expanded', 'true');
        head.tabIndex = -1;
        head.addEventListener('click', () => setDirCollapsed(dir, head, !dir.classList.contains('collapsed')));
        const children = el('div', 'dchildren');
        children.setAttribute('role', 'group'); // WAI-ARIA tree: dir treeitem owns a group
        renderNodes(node.children ?? [], children);
        dir.append(head, children);
        into.appendChild(dir);
      } else {
        const row = el('div', 'f');
        row.dataset.rel = node.relPath;
        row.title = node.relPath; // truncated name → full path on hover (§20.2)
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-selected', 'false');
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

  // WAI-ARIA tree keyboard nav (§20.2).
  list.addEventListener('keydown', (e) => {
    const row = (e.target as HTMLElement).closest('[role="treeitem"]') as HTMLElement | null;
    if (!row) return;
    const items = visibleItems();
    const i = items.indexOf(row);
    const isDir = row.classList.contains('dname');
    const dir = row.parentElement;
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
        else if (isDir) focusItem(visibleItems()[i + 1]);
        break;
      case 'ArrowLeft':
        if (isDir && dir && !dir.classList.contains('collapsed')) setDirCollapsed(dir, row, true);
        else focusItem(row.closest('.dchildren')?.parentElement?.querySelector(':scope > .dname') as HTMLElement);
        break;
      default: return;
    }
    e.preventDefault();
  });

  // Match a file's own name, not its path — else a directory whose name contains the query would
  // drag in all its files (§20.2).
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

  // Identity of a treeitem that survives a rebuild: file rows by their relPath, dir heads by their path title.
  function treeItemKey(row: HTMLElement | null): string | null {
    if (!row) return null;
    return row.classList.contains('dname') ? `d:${row.title}` : `f:${row.dataset.rel ?? ''}`;
  }

  // Structure the tree renders (filter + scope + each node's path/kind/provenance); a live reload whose
  // result matches skips the rebuild, so focus, collapse state, and scroll survive untouched (§20.1).
  function treeSignature(): string {
    const parts: string[] = [search.value.trim().toLowerCase(), scope];
    const walk = (ns: ArtifactNode[]): void => {
      for (const n of ns) {
        parts.push(n.kind, n.relPath, (n.provenance ?? []).join('+'));
        if (n.children) walk(n.children);
      }
    };
    walk(treeNodes);
    return parts.join('');
  }

  // Re-render rather than toggle visibility so nothing non-matching is ever left in the DOM (§20.2).
  function renderTree(): void {
    const sig = treeSignature();
    if (sig === renderedTreeSig) return;
    renderedTreeSig = sig;
    // Restore keyboard/SR focus to the same item across the rebuild, but only when the tree already
    // held focus, so a background live reload never steals it (WCAG 2.4.3, §20.1).
    const active = document.activeElement as HTMLElement | null;
    const focusedKey =
      active && list.contains(active) ? treeItemKey(active.closest('[role="treeitem"]') as HTMLElement | null) : null;
    const q = search.value.trim().toLowerCase();
    fileRows.clear();
    list.replaceChildren();
    renderNodes(q ? filterNodes(treeNodes, q) : treeNodes, list);
    if (current) setSelectedRow(current);
    const firstItem = visibleItems()[0]; // one row holds tabindex=0 so the tree is Tab-reachable
    if (firstItem) firstItem.tabIndex = 0;
    if (focusedKey) {
      const match = ([...list.querySelectorAll('[role="treeitem"]')] as HTMLElement[]).find(
        (r) => treeItemKey(r) === focusedKey,
      );
      if (match) focusItem(match);
    }
  }

  // Reflect single-select to assistive tech via aria-selected (§20.2 a11y).
  function setSelectedRow(relPath: string): void {
    for (const [rel, row] of fileRows) {
      const on = rel === relPath;
      row.classList.toggle('sel', on);
      row.setAttribute('aria-selected', String(on));
    }
  }

  async function open(relPath: string): Promise<void> {
    const wasCurrent = current === relPath;
    current = relPath;
    setSelectedRow(relPath);
    // An IPC failure (main restart) must render the "Cannot display" state, not escape as an
    // unhandled rejection (§20.2).
    let file: ViewerFile | null;
    try {
      file = await deps.loadFile(relPath);
    } catch {
      file = null;
    }
    if (current !== relPath) return; // a newer open won the race
    // A live reload re-opens the current file; when its content is unchanged, keep the rendered view
    // (and its scroll/selection) instead of rebuilding it (§20.1).
    const sig = file
      ? `${file.relPath} ${file.kind} ${file.lang ?? ''} ${file.body} ${(file.changedLines ?? []).join(',')}`
      : ` null ${relPath}`;
    if (wasCurrent && sig === shownSig) return;
    shownSig = sig;
    lastSelection = '';
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
      codeView = renderCode(file.body, file.lang, body, file.changedLines) ?? null;
      // A real editor owns its own focusable scroller, so the body leaves the tab order; the
      // plain-text fallback makes the body the scroll container, so it stays Tab-reachable (§20.2 a11y).
      body.tabIndex = codeView ? -1 : 0;
      sections = changedSections(file.changedLines);
      if (codeView) unsubViewport = codeView.onViewportChange(updateNav);
    } else {
      body.tabIndex = 0; // markdown scrolls in the body itself → keep it a focusable scroll region (§20.2 a11y)
      renderMarkdown(file.body, body);
      sections = [];
    }
    updateNav();
    updateActions();
  }

  async function refresh(): Promise<void> {
    const token = ++refreshSeq;
    // An IPC failure keeps the previous tree/content rather than blanking the viewer or escaping
    // as an unhandled rejection (callers use `void refresh()`, §20.2).
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
    // addToTodo crosses IPC; a rejected invoke (main restart) must not escape as an unhandled rejection.
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
      win?.removeEventListener(FOCUS_VIEW_EVENT, onFocusView);
      endDrag?.(); // remove any document-level listeners from an in-flight resize drag (§20.2)
      unsubViewport?.();
      codeView?.destroy?.(); // free CodeMirror's handlers — DOM removal alone doesn't (§20.2)
      host.replaceChildren();
    },
  };
}
