// Action window coordinator (§16): resolves the pane DOM, builds the status strip and
// the Capture/Todo tabs, and routes the window.monitor.* event stream to them. The
// per-feature DOM/state lives in statusStrip.ts, captureTab.ts, todoTab.ts; this file
// only wires events and owns tab selection. Architectural rule (§9.1): talks ONLY to
// window.monitor.* — never to the terminal pane, the renderer xterm, or selection.

import type { TabId } from '../../shared/ipc';
import { resolveMonitorElements } from './dom';
import { createStatusStrip } from './statusStrip';
import { createTodoTab } from './todoTab';
import { createCaptureTab } from './captureTab';
import { createRepoContext, type RepoContext } from './repoContext';
import { doInject, REVEAL_CAPTURE_EVENT, TODOS_CHANGED_EVENT } from './paneActions';

// Re-exported for callers that import these from the pane module (selection.ts, tests).
export {
  CAPTURE_RANGE_ADD_EVENT,
  CAPTURE_RANGE_REMOVE_EVENT,
  FOCUS_TERMINAL_EVENT,
  REVEAL_CAPTURE_EVENT,
  REVEAL_HIGHLIGHT_MS,
  REVEAL_TERMINAL_EVENT,
  TODOS_CHANGED_EVENT,
  TODO_UNDO_MS,
} from './paneActions';

export function wireMonitorPane(repo: RepoContext = createRepoContext(window.monitor)): void {
  const el = resolveMonitorElements();
  const status = createStatusStrip(el.status);
  const todoTab = createTodoTab({
    todoListEl: el.todoList,
    todoCountEl: el.todoCount,
    monitor: window.monitor,
    doInject,
  });
  const captureTab = createCaptureTab({
    blocksEl: el.blocks,
    todoSink: todoTab,
    monitor: window.monitor,
    doInject,
  });

  let activeTab: TabId = 'capture';

  // ---- Tabs (§16.1) ----
  function selectTab(tab: TabId, persist = true): void {
    activeTab = tab;
    const onCapture = tab === 'capture';
    el.panelCapture.hidden = !onCapture;
    el.panelTodo.hidden = onCapture;
    el.tabCapture.setAttribute('aria-selected', String(onCapture));
    el.tabTodo.setAttribute('aria-selected', String(!onCapture));
    if (onCapture) el.unreadDot.hidden = true;
    else todoTab.refresh();
    if (persist) window.monitor.setSettings({ lastTab: tab });
  }
  el.tabCapture.addEventListener('click', () => selectTab('capture'));
  el.tabTodo.addEventListener('click', () => selectTab('todo'));

  // Capture is manual + single-slot (§21.1): run report-detection on demand and replace the
  // shown report with the latest. Nothing auto-emits, so there is no unread dot to raise.
  el.captureLast.addEventListener('click', () => {
    void window.monitor
      .captureLast()
      // [] means nothing was detected AND main kept the prior capture (a scrolled-away buffer
      // must not wipe it) — so only replace the shown report when there's actually one (§21.1).
      .then((events) => {
        if (events.length > 0) captureTab.showReport(events);
      })
      .catch(() => {}); // a rejected invoke (main restart) must not be an unhandled rejection
  });

  window.monitor.onUpdate((msg) => status.update(msg));

  // Live captures (manual selection, §16.2) still arrive on this channel; the scanner no
  // longer auto-emits reports/findings (§21.1) — those come only via the button above.
  window.monitor.onEvent((event) => {
    captureTab.appendBlock(event);
    if (activeTab !== 'capture') el.unreadDot.hidden = false;
  });

  // Retraction (§15.3): the scanner replaced an earlier partial capture with a fuller
  // one and asks the pane to drop the superseded block (its findings cascade with it).
  window.monitor.onEventRemoved((eventId) => captureTab.removeBlock(eventId));

  // Repo-scoped todos (§16.3): the shared repo context delivers the seeded key on mount and
  // every subsequent cd; a repo-key change swaps the displayed list, unless a todo edit is
  // open — then the Todo tab defers it until the edit resolves.
  repo.onChange((info) => todoTab.onRepoChanged(info.repoKey));

  // A todo added from the terminal pane (Capture selection, §16.2) refreshes the count/list.
  window.addEventListener(TODOS_CHANGED_EVENT, () => todoTab.refresh());

  // Cross-highlight (§16.8): the terminal pane resolved a double-clicked row to the capture
  // that owns it (marker-anchored, so resize-safe) and names it by id; reveal that block.
  // Decoupled via the window-event bus so the panes never import each other (§9.1).
  window.addEventListener(REVEAL_CAPTURE_EVENT, (e) => {
    const detail = (e as CustomEvent<{ id: string }>).detail;
    if (detail) captureTab.revealById(detail.id);
  });

  window.monitor.onExit(() => status.setExited());

  void window.monitor.replay().then((events) => {
    for (const e of events) captureTab.appendBlock(e);
  });

  // Restore the remembered tab (§16.1 / §16.6) before first paint of either panel.
  void window.monitor.getSettings().then((s) => selectTab(s.lastTab, false));

  status.render();
}
