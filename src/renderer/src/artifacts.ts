// The artifact viewer (§20.2 / §24.1): view 2's file tree + viewer. A placement-agnostic
// organism (UI-STANDARDS §1.2/§1.3) — it builds and touches only its host subtree, takes
// the heavy render stack (markdown-it + mermaid, CodeMirror) and the two §16.2 sinks as
// injected seams, and themes through tokens only. Phase 1 is fed by a renderer-local
// fixture artifact set; real discovery + provenance (`viewer:tree`, §20.1) stays in the
// §24.2 backlog. Code renders read-only; a selection in either view routes to the same
// two sinks as the terminal-pane selection (send-to-agent / add-to-todo, §16.2).

export type ArtifactKind = 'markdown' | 'code';

export interface Artifact {
  id: string;
  name: string;
  /** Tree section header (provenance group, §20.1). */
  group: string;
  /** Provenance tag shown on the row (e.g. "iter 03", "open"). */
  tag: string;
  icon: string;
  kind: ArtifactKind;
  lang?: string;
  body: string;
}

/** Phase-1 fixture set (real discovery is mocked, §24.1) — a review loop's artifacts. */
export const SAMPLE_ARTIFACTS: Artifact[] = [
  {
    id: 'review',
    name: 'review.md',
    group: 'This run',
    tag: 'iter 03',
    icon: 'md',
    kind: 'markdown',
    body: [
      '# Review — capture pipeline',
      '',
      '_review.md · iter 03 · 2 findings_',
      '',
      'The scanner now carves tool calls out of the report body, so a tool-heavy turn yields',
      'clean prose plus findings rather than a blob.',
      '',
      '## Flow',
      '',
      '```mermaid',
      'flowchart LR',
      '  A[PTY output] --> B[shadow screen]',
      '  B --> C{quiet?}',
      '  C -->|yes| D[capture last report]',
      '  C -->|no| B',
      '```',
      '',
      '## Stability frontier',
      '',
      'However, the frontier still re-reads scrollback on every quiet pause, which on a long',
      'session is measurable overhead. A second pass also drops findings under the',
      'minimum-character floor without flagging them.',
      '',
      '## Command-output capture',
      '',
      'Unchanged and behaves correctly across the test session. Select any passage to send it',
      'to the terminal or add it as a todo.',
      '',
    ].join('\n'),
  },
  {
    id: 'plan',
    name: 'plan.md',
    group: 'This run',
    tag: 'step 1',
    icon: 'md',
    kind: 'markdown',
    body: [
      '# Plan',
      '',
      '1. Carve tool calls out of the report body.',
      '2. Bound the scrollback re-scan.',
      '3. Flag sub-floor findings instead of dropping them.',
      '',
    ].join('\n'),
  },
  {
    id: 'scanner',
    name: 'scanner.ts',
    group: 'This run',
    tag: 'code',
    icon: 'ts',
    kind: 'code',
    lang: 'typescript',
    body: [
      'export const QUIET_MS = 500;',
      '',
      'export function captureLast(reader: BufferReader): CaptureLastResult | null {',
      "  if (reader.bufferType() === 'alternate') return null;",
      '  const endRow = reader.length() - 1;',
      '  if (endRow < 0) return null;',
      '  const { allRegions } = detectRegions(0, endRow);',
      "  const region = allRegions.filter((r) => r.type === 'report').at(-1);",
      '  return region ? toEmission(region) : null;',
      '}',
    ].join('\n'),
  },
  {
    id: 'pr',
    name: 'PR #42',
    group: 'GitHub',
    tag: 'open',
    icon: '⌥',
    kind: 'markdown',
    body: [
      '# PR #42 — capture pipeline hardening',
      '',
      'Carves tool calls out of report bodies and bounds the scrollback re-scan.',
      '',
      '- [x] tool-call carving',
      '- [ ] bounded re-scan',
      '- [ ] sub-floor finding flag',
      '',
    ].join('\n'),
  },
];

/** Render seams + sinks, all injected (UI-STANDARDS §2.2). */
export interface ArtifactsDeps {
  artifacts?: Artifact[];
  /** Send the selection to the agent (inject, §9.3). */
  send: (text: string) => void;
  /** Add the selection to the repo-scoped todo list (§16.2). */
  addToTodo: (text: string) => void | Promise<void>;
  renderMarkdown?: (body: string, into: HTMLElement) => void;
  renderCode?: (body: string, lang: string | undefined, into: HTMLElement) => void;
  /** Current selection text within the viewer body (defaults to the live DOM selection). */
  readSelection?: (viewer: HTMLElement) => string;
}

export interface Artifacts {
  open(id: string): void;
  current(): string | null;
  dispose(): void;
}

const plainMarkdown = (body: string, into: HTMLElement): void => {
  into.replaceChildren();
  const pre = into.ownerDocument.createElement('pre');
  pre.textContent = body;
  into.appendChild(pre);
};
const plainCode = (body: string, _lang: string | undefined, into: HTMLElement): void => {
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

export function createArtifacts(host: HTMLElement, deps: ArtifactsDeps): Artifacts {
  const doc = host.ownerDocument;
  const artifacts = deps.artifacts ?? SAMPLE_ARTIFACTS;
  const renderMarkdown = deps.renderMarkdown ?? plainMarkdown;
  const renderCode = deps.renderCode ?? plainCode;
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
  search.placeholder = 'Filter artifacts';
  search.setAttribute('aria-label', 'Filter artifacts');
  const list = el('div', 'treelist');
  tree.append(search, list);

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

  split.append(tree, viewer);
  host.appendChild(split);

  let current: string | null = null;
  const rows = new Map<string, HTMLElement>();
  // Clicking an action button collapses the live DOM selection (the button takes focus on
  // mousedown) before the click handler runs, so we remember the last non-empty in-viewer
  // selection as it happens and fall back to it at click time.
  let lastSelection = '';
  const onSelectionChange = (): void => {
    const text = readSelection(body);
    if (text) lastSelection = text;
  };
  doc.addEventListener('selectionchange', onSelectionChange);

  function renderTree(filter = ''): void {
    list.replaceChildren();
    rows.clear();
    const q = filter.trim().toLowerCase();
    const groups = new Map<string, Artifact[]>();
    for (const a of artifacts) {
      if (q && !a.name.toLowerCase().includes(q)) continue;
      (groups.get(a.group) ?? groups.set(a.group, []).get(a.group)!).push(a);
    }
    for (const [group, items] of groups) {
      list.appendChild(el('div', 'grp', group));
      for (const a of items) {
        const row = el('div', 'f');
        row.dataset.artId = a.id;
        row.append(el('span', 'ic', a.icon), el('span', 'fn', a.name), el('span', 'tag', a.tag));
        if (a.id === current) row.classList.add('sel');
        row.addEventListener('click', () => open(a.id));
        rows.set(a.id, row);
        list.appendChild(row);
      }
    }
  }

  function open(id: string): void {
    const a = artifacts.find((x) => x.id === id);
    if (!a) return;
    current = id;
    lastSelection = ''; // the prior artifact's selection no longer applies
    for (const [rid, row] of rows) row.classList.toggle('sel', rid === id);
    title.textContent = a.name;
    meta.textContent = `${a.group} · ${a.tag}`;
    if (a.kind === 'code') renderCode(a.body, a.lang, body);
    else renderMarkdown(a.body, body);
  }

  function routeSelection(sink: (text: string) => void | Promise<void>): void {
    const text = readSelection(body) || lastSelection;
    if (!text) return;
    void sink(text);
  }

  sendBtn.addEventListener('click', () => routeSelection(deps.send));
  todoBtn.addEventListener('click', () => routeSelection(deps.addToTodo));
  search.addEventListener('input', () => renderTree(search.value));

  renderTree();
  if (artifacts.length > 0) open(artifacts[0].id);

  return {
    open,
    current: () => current,
    dispose: () => {
      doc.removeEventListener('selectionchange', onSelectionChange);
      host.replaceChildren();
    },
  };
}
