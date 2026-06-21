// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wireMonitorPane, REVEAL_TERMINAL_EVENT } from '../../src/renderer/src/monitor';
import { createCaptureTab } from '../../src/renderer/src/captureTab';
import { assertRendersFromHostDocument } from './relocatable';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import type { MonitorEvent, TodoItem, UiSettings } from '../../src/shared/ipc';

const flush = () => new Promise((r) => setTimeout(r, 0));

const MONITOR_HTML = `
  <div id="monitor-tabs" role="tablist">
    <button id="tab-capture" role="tab" aria-selected="true" aria-controls="panel-capture">
      Capture<span id="capture-unread" class="unread-dot" hidden></span>
    </button>
    <button id="tab-todo" role="tab" aria-selected="false" aria-controls="panel-todo">
      Todo <span id="todo-count" class="todo-count">0</span>
    </button>
  </div>
  <section id="panel-capture" role="tabpanel">
    <div id="monitor-status" role="status" aria-live="polite"></div>
    <div class="head"><button id="capture-last">Capture last report</button></div>
    <div id="monitor-blocks"></div>
  </section>
  <section id="panel-todo" role="tabpanel" hidden>
    <div id="todo-list"></div>
  </section>`;

function makeEvent(over: Partial<MonitorEvent>): MonitorEvent {
  return {
    id: 'e1',
    sessionId: 's1',
    type: 'report',
    text: 'a captured report worth keeping',
    capturedAt: Date.parse('2026-06-12T10:00:00.000Z'),
    truncated: false,
    ...over,
  } as MonitorEvent;
}

// §24.2.1 bulk triage: each capture card carries a selection checkbox; the toolbar's
// "Add to todo" concatenates the checked chunks (appeared order, blank-line separated) into
// ONE todo with an Undo window + processed-chunk cue, and "Dismiss selected" / "Dismiss all"
// clear cards. This supersedes the per-card "Add to todo" the mockup shipped.
describe('Capture tab §24.2.1 — bulk triage (checkbox + Add to todo / Dismiss)', () => {
  let handlers: {
    event?: (e: MonitorEvent) => void;
    cwdChanged?: (m: { sessionId: string; cwd: string; repoKey: string }) => void;
  };
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  function makeMonitor(): Record<string, ReturnType<typeof vi.fn>> {
    let nextId = 0;
    return {
      onEvent: vi.fn((cb) => (handlers.event = cb)),
      onEventRemoved: vi.fn(),
      onUpdate: vi.fn(),
      onExit: vi.fn(),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn((cb) => (handlers.cwdChanged = cb)),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      clearCommands: vi.fn(),
      learnChrome: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => ({ ...DEFAULT_UI_SETTINGS })),
      setSettings: vi.fn(),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async (repoKey: string, text: string): Promise<TodoItem[]> => [
        { id: `t${nextId++}`, repoKey, text, status: 'active', order: 1, createdAt: '2026-06-12T10:00:00.000Z' },
      ]),
      todoUpdate: vi.fn(async () => []),
      todoReorder: vi.fn(async () => []),
      todoSetStatus: vi.fn(async () => []),
      todoDelete: vi.fn(async () => []),
      listTemplates: vi.fn(async () => ({ templates: [] })),
      instantiateTemplate: vi.fn(async () => []),
    };
  }

  // Fake timers throughout so the TODO_UNDO_MS window is deterministic; `tick()` flushes
  // microtasks (the pane's mount-time .then() chains) without a wall-clock wait.
  const tick = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = MONITOR_HTML;
    handlers = {};
    monitor = makeMonitor();
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const blocks = () => document.getElementById('monitor-blocks')!;
  const cards = () => Array.from(blocks().querySelectorAll('.finding')) as HTMLElement[];
  const checkbox = (card: HTMLElement) => card.querySelector('.chunk-check') as HTMLInputElement;
  const addBtn = () => document.getElementById('add-selected-todo') as HTMLButtonElement;
  const dismissSelected = () => document.getElementById('dismiss-selected') as HTMLButtonElement;
  const dismissAll = () => document.getElementById('dismiss-all') as HTMLButtonElement;

  async function withRepo(repoKey = '/repoA'): Promise<void> {
    wireMonitorPane();
    await tick();
    handlers.cwdChanged!({ sessionId: 's1', cwd: repoKey, repoKey });
    await tick();
  }

  it('every capture card carries a selection checkbox and no per-card Add-to-todo button', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'a finding' }));
    expect(checkbox(cards()[0])).toBeTruthy();
    expect(blocks().querySelector('.add-to-todo')).toBeNull();
    expect(addBtn().disabled).toBe(true);
  });

  it('checking findings and clicking Add to todo concatenates them (appeared order, blank-line separated) into one todo', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    handlers.event!(makeEvent({ id: 'f2', type: 'finding', parentId: null, text: 'beta' }));
    for (const c of cards()) checkbox(c).click();
    expect(addBtn().disabled).toBe(false);
    addBtn().click();
    await tick();
    expect(monitor.todoAdd).toHaveBeenCalledTimes(1);
    expect(monitor.todoAdd).toHaveBeenCalledWith('/repoA', 'alpha\n\nbeta', { type: 'capture' });
  });

  it('after Add to todo the contributing chunks read as processed (dimmed + checkbox disabled) during the undo window', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    const card = blocks().querySelector('[data-event-id="f1"]') as HTMLElement;
    expect(card.classList.contains('chunk-processed')).toBe(true);
    expect(checkbox(card).disabled).toBe(true);
    expect(document.querySelector('.undo-add-to-todo')).toBeTruthy();
  });

  it('Undo within the window deletes the added todo and leaves the chunk (nothing dismissed)', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    (document.querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.todoDelete).toHaveBeenCalledTimes(1);
    expect(monitor.dismiss).not.toHaveBeenCalled();
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
  });

  it('when the undo window elapses the contributing chunks are dismissed and removed', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.dismiss).toHaveBeenCalledWith('f1');
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeNull();
  });

  it('Dismiss selected dismisses and removes the checked chunks', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    handlers.event!(makeEvent({ id: 'f2', type: 'finding', parentId: null, text: 'beta' }));
    checkbox(cards().find((c) => c.dataset.eventId === 'f1')!).click();
    expect(dismissSelected().disabled).toBe(false);
    dismissSelected().click();
    expect(monitor.dismiss).toHaveBeenCalledWith('f1');
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeNull();
    expect(blocks().querySelector('[data-event-id="f2"]')).toBeTruthy();
  });

  it('Dismiss all clears every card and calls dismissAll', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    handlers.event!(makeEvent({ id: 'f2', type: 'finding', parentId: null, text: 'beta' }));
    dismissAll().click();
    expect(monitor.dismissAll).toHaveBeenCalledTimes(1);
    expect(cards()).toHaveLength(0);
  });

  it('if the add silently fails (nothing returned), the source chunks are NOT dismissed', async () => {
    await withRepo();
    monitor.todoAdd.mockResolvedValue([]); // add yields no new item → addFromCapture returns null
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.dismiss).not.toHaveBeenCalled();
    expect(blocks().querySelector('[data-event-id="f1"]')).toBeTruthy();
  });

  // A main-process restart rejects the underlying todo IPC; the click handlers must not surface
  // an unhandled rejection (vitest fails on one) and must never leave the UI stuck (§16.2).
  it('a rejected Add to todo is handled and does not leave the chunk stuck as processed', async () => {
    await withRepo();
    monitor.todoAdd.mockRejectedValueOnce(new Error('ipc down'));
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    const card = blocks().querySelector('[data-event-id="f1"]') as HTMLElement;
    expect(card.classList.contains('chunk-processed')).toBe(false);
    expect(document.querySelector('.undo-add-to-todo')).toBeNull();
  });

  it('a rejected Undo (deleteTodo) still ends the undo window (chunks not left disabled)', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    monitor.todoDelete.mockRejectedValueOnce(new Error('ipc down'));
    (document.querySelector('.undo-add-to-todo') as HTMLButtonElement).click();
    await tick();
    expect(document.querySelector('.undo-add-to-todo')).toBeNull();
    const card = blocks().querySelector('[data-event-id="f1"]') as HTMLElement;
    expect(card.classList.contains('chunk-processed')).toBe(false);
  });

  it('Dismiss all during the undo window ends the undo state (toolbar not left stuck)', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'alpha' }));
    checkbox(cards()[0]).click();
    addBtn().click();
    await tick();
    expect(document.querySelector('.undo-add-to-todo')).toBeTruthy(); // undo window open
    dismissAll().click();
    expect(document.querySelector('.undo-add-to-todo')).toBeNull(); // undo slot cleared
    expect(addBtn().disabled).toBe(true); // no chunks left, but NOT stuck-disabled by undoPending
    // The pending commit timer must not fire against already-removed chunks.
    monitor.dismiss.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(monitor.dismiss).not.toHaveBeenCalled();
  });

  it('each chunk checkbox is distinguishable — its label carries the capture text', async () => {
    await withRepo();
    handlers.event!(makeEvent({ id: 'f1', type: 'finding', parentId: null, text: 'unbounded scrollback re-scan' }));
    const label = checkbox(cards()[0]).getAttribute('aria-label') ?? '';
    expect(label).toContain('unbounded scrollback re-scan');
  });
});

// §21.1 / v2.27: capture is manual + single-slot — clicking "Capture last report" runs
// detection on demand (capture:last) and the pane shows the one returned report's findings,
// replacing whatever it showed before. Nothing auto-emits.
describe('Capture last report button (§21.1 — manual single-slot)', () => {
  let settings: UiSettings;
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    settings = { ...DEFAULT_UI_SETTINGS };
    monitor = {
      onEvent: vi.fn(),
      onEventRemoved: vi.fn(),
      onUpdate: vi.fn(),
      onExit: vi.fn(),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn(),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      clearCommands: vi.fn(),
      learnChrome: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => settings),
      setSettings: vi.fn(),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async () => []),
      todoUpdate: vi.fn(async () => []),
      todoReorder: vi.fn(async () => []),
      todoSetStatus: vi.fn(async () => []),
      todoDelete: vi.fn(async () => []),
      listTemplates: vi.fn(async () => ({ templates: [] })),
      instantiateTemplate: vi.fn(async () => []),
    };
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  const button = () => document.getElementById('capture-last') as HTMLButtonElement;
  const findings = () => Array.from(document.getElementById('monitor-blocks')!.querySelectorAll('.finding')) as HTMLElement[];
  const text = (el: HTMLElement) => el.querySelector('.t')!.textContent;

  function report(id: string, t: string): MonitorEvent {
    return makeEvent({ id, type: 'finding', parentId: 'r1', text: t, range: { start: { x: 0, y: 0 }, end: { x: 80, y: 0 }, baseY: 0, bufferType: 'normal' } });
  }

  it('clicking the button runs capture:last and renders the returned findings', async () => {
    monitor.captureLast.mockResolvedValue([report('f1', 'first finding'), report('f2', 'second finding')]);
    wireMonitorPane();
    await flush();

    button().click();
    await flush();

    expect(monitor.captureLast).toHaveBeenCalledTimes(1);
    expect(findings().map(text)).toEqual(['first finding', 'second finding']);
  });

  it('a second capture replaces the prior findings (single-slot)', async () => {
    monitor.captureLast.mockResolvedValueOnce([report('f1', 'old finding')]);
    wireMonitorPane();
    await flush();
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['old finding']);

    monitor.captureLast.mockResolvedValueOnce([report('f9', 'fresh finding')]);
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['fresh finding']);
  });

  it('double-clicking a captured finding asks the terminal to reveal its rows (§16.8)', async () => {
    monitor.captureLast.mockResolvedValue([report('f1', 'ranged finding')]);
    wireMonitorPane();
    await flush();
    button().click();
    await flush();

    let revealedId: string | undefined;
    window.addEventListener(REVEAL_TERMINAL_EVENT, (e) => {
      revealedId = (e as CustomEvent<{ id: string }>).detail.id;
    });
    findings()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(revealedId).toBe('f1');
  });

  it('an empty result (nothing detected) leaves the shown report in place — does not clear it', async () => {
    // capture:last returns [] when no report is detected AND main keeps the prior capture
    // (a scrolled-away buffer must not wipe it), so the pane must not clear on [].
    monitor.captureLast.mockResolvedValueOnce([report('f1', 'kept finding')]);
    wireMonitorPane();
    await flush();
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['kept finding']);

    monitor.captureLast.mockResolvedValueOnce([]);
    button().click();
    await flush();
    expect(findings().map(text)).toEqual(['kept finding']); // unchanged
  });

  it('a rejected capture:last is handled, not an unhandled rejection', async () => {
    // vitest fails the run on an unhandled rejection, so this passes only if the click handler
    // catches a rejected invoke (e.g. main restart).
    monitor.captureLast.mockRejectedValueOnce(new Error('main restarted'));
    wireMonitorPane();
    await flush();
    button().click();
    await flush();
    expect(findings()).toHaveLength(0); // no crash, nothing rendered
  });
});

// §24.2.1 report prose / summary view: the mockup carves only findings, so a report that
// carves none used to render nothing. Give the report body a home — an expandable summary
// card — without reintroducing the dominating blob.
describe('Capture tab §24.2.1 — report prose fallback (report with no findings, §15.x)', () => {
  let monitor: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    document.body.innerHTML = MONITOR_HTML;
    monitor = {
      onEvent: vi.fn(),
      onEventRemoved: vi.fn(),
      onUpdate: vi.fn(),
      onExit: vi.fn(),
      onCommandsChanged: vi.fn(),
      onCwdChanged: vi.fn(),
      currentRepo: vi.fn(async () => null),
      replay: vi.fn(async () => []),
      commands: vi.fn(async () => []),
      captureCommandText: vi.fn(async () => null),
      captureLast: vi.fn(async () => []),
      dismiss: vi.fn(),
      dismissAll: vi.fn(),
      clearCommands: vi.fn(),
      learnChrome: vi.fn(),
      inject: vi.fn(),
      getSettings: vi.fn(async () => ({ ...DEFAULT_UI_SETTINGS })),
      setSettings: vi.fn(),
      todoList: vi.fn(async () => []),
      todoAdd: vi.fn(async () => []),
      todoUpdate: vi.fn(async () => []),
      todoReorder: vi.fn(async () => []),
      todoSetStatus: vi.fn(async () => []),
      todoDelete: vi.fn(async () => []),
      listTemplates: vi.fn(async () => ({ templates: [] })),
      instantiateTemplate: vi.fn(async () => []),
    };
    (window as unknown as { monitor: typeof monitor }).monitor = monitor;
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('a report that carves no findings renders its prose in an expandable card, not nothing', async () => {
    monitor.captureLast.mockResolvedValue([
      makeEvent({ id: 'r1', type: 'report', parentId: null, text: 'overall the change looks correct but watch the scrollback bound' }),
    ]);
    wireMonitorPane();
    await flush();
    (document.getElementById('capture-last') as HTMLButtonElement).click();
    await flush();

    const card = document.querySelector('.finding.report-prose') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector('details')).toBeTruthy();
    expect(card.textContent).toContain('watch the scrollback bound');
  });
});

// UI-STANDARDS §3.3 / §2.2 rule 1: the organism must build its DOM from the host's
// ownerDocument, never the ambient global document — else it is not relocatable to a
// separate-process pane. See memory jsdom-adoption-masks-global-document.
describe('Capture tab — relocation (UI-STANDARDS §3.3)', () => {
  it('builds toolbar + cards from host.ownerDocument, not the global document', async () => {
    await assertRendersFromHostDocument((h) => {
      const blocks = h.ownerDocument.createElement('div');
      h.appendChild(blocks);
      const tab = createCaptureTab({
        blocksEl: blocks,
        todoSink: { currentRepoKey: () => null, addFromCapture: async () => null, deleteTodo: async () => {} },
        monitor: { dismiss: () => {}, dismissAll: () => {} },
        doInject: () => {},
      });
      tab.appendBlock({
        id: 'e1',
        sessionId: 's1',
        type: 'finding',
        source: 'selection',
        text: 'a finding worth keeping',
        range: null,
        parentId: null,
        truncated: false,
        capturedAt: '2026-06-12T10:00:00.000Z',
      } as MonitorEvent);
    });
  });
});
