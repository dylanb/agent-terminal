// Action window coordinator (§16): wires the window.monitor.* event stream to the strip/tabs and
// owns tab selection. Architectural rule (§9.1): talks ONLY to window.monitor.* — never to the
// terminal pane, the renderer xterm, or selection.

import type { TabId } from '../../shared/ipc';
import { resolveMonitorElements } from './dom';
import { createStatusStrip } from './statusStrip';
import { createTodoTab } from './todoTab';
import { createCaptureTab } from './captureTab';
import { createRepoContext, type RepoContext } from './repoContext';
import { doInject, FLOW_CHANGED_EVENT, REVEAL_CAPTURE_EVENT, TODOS_CHANGED_EVENT } from './paneActions';

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

  // Capture is manual + single-slot (§21.1): nothing auto-emits, so there is no unread dot to raise.
  el.captureLast.addEventListener('click', () => {
    void window.monitor
      .captureLast()
      // [] means nothing detected AND main kept the prior capture (a scrolled-away buffer must not
      // wipe it), so only replace when there's actually a report (§21.1).
      .then((events) => {
        if (events.length > 0) captureTab.showReport(events);
      })
      .catch(() => {}); // a rejected invoke (main restart) must not be an unhandled rejection
  });

  window.monitor.onUpdate((msg) => status.update(msg));

  // Live captures (manual selection, §16.2) still arrive here; the scanner no longer auto-emits
  // reports/findings (§21.1) — those come only via the button above.
  window.monitor.onEvent((event) => {
    captureTab.appendBlock(event);
    if (activeTab !== 'capture') el.unreadDot.hidden = false;
  });

  // §15.3 retraction: a partial capture was superseded by a fuller one; drop the stale block.
  window.monitor.onEventRemoved((eventId) => captureTab.removeBlock(eventId));

  // #26: main cleared the global store as part of a flow Terminate; reflect the empty capture tab.
  window.monitor.onCleared(() => captureTab.clearAll());

  // Repo-scoped todos (§16.3); a repo-key change swaps the displayed list.
  repo.onChange((info) => todoTab.onRepoChanged(info.repoKey));

  window.addEventListener(TODOS_CHANGED_EVENT, () => todoTab.refresh());
  window.addEventListener(FLOW_CHANGED_EVENT, () => todoTab.refresh());

  window.addEventListener(REVEAL_CAPTURE_EVENT, (e) => {
    const detail = (e as CustomEvent<{ id: string }>).detail;
    if (detail) captureTab.revealById(detail.id);
  });

  window.monitor.onExit(() => status.setExited());

  void window.monitor
    .replay()
    .then((events) => {
      for (const e of events) captureTab.appendBlock(e);
    })
    .catch(() => {}); // a rejected invoke (main restart) must not be an unhandled rejection

  // Restore the remembered tab (§16.1 / §16.6) before first paint.
  void window.monitor
    .getSettings()
    .then((s) => selectTab(s.lastTab, false))
    .catch(() => {}); // a rejected invoke keeps the markup default tab, never rejects

  status.render();
}
