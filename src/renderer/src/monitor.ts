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
import { TODOS_CHANGED_EVENT } from './paneActions';

// Re-exported for callers that import these from the pane module (selection.ts, tests).
export { FOCUS_TERMINAL_EVENT, TODOS_CHANGED_EVENT, TODO_UNDO_MS } from './paneActions';

export function wireMonitorPane(): void {
  const el = resolveMonitorElements();
  const status = createStatusStrip(el.status);
  const todoTab = createTodoTab({ todoListEl: el.todoList, todoCountEl: el.todoCount, monitor: window.monitor });
  const captureTab = createCaptureTab({
    blocksEl: el.blocks,
    historyEl: el.history,
    monitor: window.monitor,
    todoSink: todoTab,
  });

  let activeTab: TabId = 'capture';
  const pullCommands = (): void => void window.monitor.commands().then((c) => captureTab.renderCommands(c));

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

  window.monitor.onUpdate((msg) => {
    status.update(msg);
    pullCommands();
  });

  window.monitor.onEvent((event) => {
    captureTab.appendBlock(event);
    // Unread dot (§16.1): a capture arrived while another tab was active.
    if (activeTab !== 'capture') el.unreadDot.hidden = false;
  });

  // Retraction (§15.3): the scanner replaced an earlier partial capture with a fuller
  // one and asks the pane to drop the superseded block (its findings cascade with it).
  window.monitor.onEventRemoved((eventId) => captureTab.removeBlock(eventId));

  window.monitor.onCommandsChanged(() => pullCommands());

  // Repo-scoped todos (§16.3): a repo-key change swaps the displayed list, unless a
  // todo edit is open — then the Todo tab defers it until the edit resolves.
  window.monitor.onCwdChanged((m) => todoTab.onRepoChanged(m.repoKey));
  // The live broadcast fires only on key *change*; the first OSC 7 may predate this
  // subscription, so seed the repo key on mount or the todo actions silently no-op.
  void window.monitor.currentRepo().then((r) => {
    if (r) todoTab.onRepoChanged(r.repoKey);
  });

  // A todo added from the terminal pane (Capture selection, §16.2) refreshes the count/list.
  window.addEventListener(TODOS_CHANGED_EVENT, () => todoTab.refresh());

  window.monitor.onExit(() => status.setExited());

  void window.monitor.replay().then((events) => {
    for (const e of events) captureTab.appendBlock(e);
  });
  pullCommands();

  // Restore the remembered tab (§16.1 / §16.6) before first paint of either panel.
  void window.monitor.getSettings().then((s) => selectTab(s.lastTab, false));

  status.render();
}
