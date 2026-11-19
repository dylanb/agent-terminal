import { cardCounts, cardStatus, statusSummary, type CardStatusClass } from '../../shared/controllerCardClassification';
import { directoryCards, type ControllerDirectoryCard } from '../../shared/controllerCards';
import { attentionText, attentionUpdate } from './controllerCardConditions';
import { reconcileChildren } from './dom';
import { CONTROLLER_DEFAULT_SORT_MODE, CONTROLLER_DEFAULT_THEME, type ControllerApi, type ControllerSortMode, type ControllerTimelineEntry, type Theme } from '../../shared/ipc';
import { createControllerCard, type ControllerCard } from './controllerCard';
import { createCardOrder, type CardListEntry } from './controllerCardOrder';
import type { ControllerClock, ControllerLayout, ControllerWindowFocus } from './controllerFrame';
import { createAlwaysOnTopControl } from './alwaysOnTopControl';
import { createThemeToggle } from './themeToggle';
import { createSortModeControl } from './sortModeControl';

export interface ControllerPanesDeps {
  controller: ControllerApi;
  layout: ControllerLayout;
  clock: ControllerClock;
  windowFocus: ControllerWindowFocus;
  applyTheme(theme: Theme): void;
}

type NotificationEntry = Extract<ControllerTimelineEntry, { kind: 'notification' }>;
const newestNotification = (timeline: readonly ControllerTimelineEntry[] | undefined): NotificationEntry | undefined =>
  timeline?.find((entry): entry is NotificationEntry => entry.kind === 'notification');

const EXPANDED_IN_ONE_COLUMN: ReadonlySet<CardStatusClass> = new Set(['error', 'needs-human']);

const SORT_SENTENCES: Readonly<Record<ControllerSortMode, string>> = {
  attention: 'Sorted by attention: errors first, then needs a human, idle & unassigned, and working, each longest in its state first.',
  'recently-used': 'Sorted by your most recent use of each card in this controller; cards you have not used yet follow in attention order.',
};

function windowHeader(doc: Document): { element: HTMLElement; render(directories: readonly ControllerDirectoryCard[]): void } {
  const element = doc.createElement('header');
  element.className = 'controller-header';
  const title = doc.createElement('h1');
  title.className = 'controller-title serif';
  title.textContent = 'Controller';
  const counts = doc.createElement('p');
  counts.className = 'controller-counts';
  const summary = doc.createElement('p');
  summary.className = 'controller-summary';
  element.append(title, ' ', counts, ' ', summary);
  const items = (texts: readonly [string, string?][]) => texts.flatMap(([text, statusClass], index) => {
    const item = doc.createElement('span');
    if (statusClass) item.dataset.status = statusClass;
    item.textContent = text;
    return index ? [' · ', item] : [item];
  });
  return {
    element,
    render(directories) {
      const { total, connected, disconnected } = cardCounts(directories);
      counts.replaceChildren(...items([
        [`${total} ${total === 1 ? 'card' : 'cards'}`],
        [`${connected} connected`],
        [`${disconnected} disconnected`],
      ]));
      summary.replaceChildren(...items(statusSummary(directories).map(({ label, statusClass, count }) => [`${count} ${label}`, statusClass] as [string, string])));
    },
  };
}

export function createControllerPanes(host: HTMLElement, deps: ControllerPanesDeps): { dispose(): void } {
  let disposed = false;
  let activation = 0;
  const doc = host.ownerDocument;
  host.classList.add('controller-panes');
  const header = windowHeader(doc);
  const list = doc.createElement('div');
  list.className = 'controller-pane-list';
  const alert = doc.createElement('p');
  alert.setAttribute('role', 'alert');
  alert.setAttribute('aria-live', 'assertive');
  const status = doc.createElement('p');
  status.className = 'controller-status-announcement';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-atomic', 'true');
  let previousAttention = new Map<string, string>();
  let previousNotifications = new Map<string, NotificationEntry>();
  let cards = new Map<string, { directory: ControllerDirectoryCard; card: ControllerCard }>();
  const order = createCardOrder();
  let observed = false;
  let directories: ControllerDirectoryCard[] = [];
  let sortMode = CONTROLLER_DEFAULT_SORT_MODE;
  const recency = new Map<string, number>();
  let uses = 0;
  let held: ReadonlySet<string> = new Set();
  let pointerOver: string | undefined;
  let focusedNode: Node | null = null;
  host.append(header.element, list, alert, status);
  const controlSlot = () => {
    const slot = doc.createElement('span');
    slot.className = 'controller-header-control';
    return slot;
  };
  const alwaysOnTopSlot = controlSlot();
  const themeSlot = controlSlot();
  const sortSlot = controlSlot();
  const sentence = doc.createElement('p');
  sentence.className = 'controller-sort-sentence';
  sentence.textContent = SORT_SENTENCES[sortMode];
  header.element.append(' ', alwaysOnTopSlot, ' ', themeSlot, ' ', sortSlot, sentence);
  const alwaysOnTopControl = createAlwaysOnTopControl(alwaysOnTopSlot, { controller: deps.controller });
  const showSortMode = (next: ControllerSortMode) => {
    sortMode = next;
    sentence.textContent = SORT_SENTENCES[next];
    renderList();
  };
  let sortControl: { dispose(): void } | undefined;
  void deps.controller.getSortMode().catch((error: unknown): ControllerSortMode => {
    console.error(`Controller sort mode not read: ${error instanceof Error ? error.message : String(error)}`);
    return CONTROLLER_DEFAULT_SORT_MODE;
  }).then(saved => {
    if (disposed) return;
    if (saved !== sortMode) showSortMode(saved);
    sortControl = createSortModeControl(sortSlot, {
      mode: saved,
      onChange(next) {
        showSortMode(next);
        return deps.controller.setSortMode(next).catch(error => console.error(`Controller sort mode not saved: ${error instanceof Error ? error.message : String(error)}`));
      },
    });
  });
  let themeToggle: { dispose(): void } | undefined;
  void deps.controller.getTheme().catch((): Theme => CONTROLLER_DEFAULT_THEME).then(theme => {
    if (disposed) return;
    deps.applyTheme(theme);
    themeToggle = createThemeToggle(themeSlot, {
      theme,
      onChange(next) {
        deps.applyTheme(next);
        void deps.controller.setTheme(next).catch(error => console.error(`Controller theme not saved: ${error instanceof Error ? error.message : String(error)}`));
      },
    });
  });

  const expandedFor = (directory: ControllerDirectoryCard): boolean =>
    !deps.layout.oneColumn() || EXPANDED_IN_ONE_COLUMN.has(cardStatus(directory).statusClass);
  const applyLayout = () => { host.dataset.layout = deps.layout.oneColumn() ? 'one-column' : 'multi-column'; };
  applyLayout();
  const unsubscribeClock = deps.clock.onTick(() => {
    const now = deps.clock.now();
    for (const { directory, card } of cards.values()) card.setTimeText(order.timeInState(directory, now));
  });
  const unsubscribeLayout = deps.layout.onChange(() => {
    applyLayout();
    for (const { directory, card } of cards.values()) card.setExpandedByDefault(expandedFor(directory));
  });

  const announce = () => {
    if (disposed) return;
    alert.replaceChildren();
    alert.textContent = 'Terminal unavailable';
  };

  function announceAttention(directories: readonly ControllerDirectoryCard[]): void {
    const currentAttention = new Map<string, string>();
    const currentNotifications = new Map<string, NotificationEntry>();
    const announcements: string[] = [];
    for (const directory of directories) {
      const notification = directory.kind === 'single' ? newestNotification(directory.timeline) : previousNotifications.get(directory.launchDirectory);
      if (notification) currentNotifications.set(directory.launchDirectory, notification);
      if (directory.kind === 'disconnected') continue;
      const text = directory.kind === 'conflict' ? 'Duplicate directory' : attentionText(directory.work);
      const key = directory.launchDirectory;
      currentAttention.set(key, text);
      const previous = previousAttention.get(key) ?? '';
      const update = previous === 'Duplicate directory' && text !== previous
        ? `Duplicate directory cleared${text ? `. ${text}` : ''}` : attentionUpdate(previous, text);
      if (update) announcements.push(`${directory.launchDirectory}: ${update}`);
      const previousNotification = previousNotifications.get(key);
      if (directory.kind === 'single' && notification
        && (notification.message !== previousNotification?.message || notification.receivedAt !== previousNotification?.receivedAt)) {
        announcements.push(`${key}: Received notification. ${notification.message}`);
      }
    }
    for (const [directory, text] of previousAttention) {
      if (text === 'Duplicate directory' && !currentAttention.has(directory)) announcements.push(`${directory}: Duplicate directory cleared`);
    }
    if (announcements.length || [...previousAttention.keys()].some(id => !currentAttention.has(id))) {
      status.textContent = announcements.join('\n');
    }
    previousAttention = currentAttention;
    previousNotifications = currentNotifications;
  }

  const headings = new Map<string, HTMLElement>();
  function headingShown(entry: Exclude<CardListEntry, { kind: 'card' }>): { key: string; text: string } {
    switch (entry.kind) {
      case 'group':
        return { key: entry.group, text: `${entry.name} (${entry.count})` };
      case 'recent':
        return { key: entry.kind, text: entry.name };
      default:
        return entry satisfies never;
    }
  }
  function groupHeading(entry: Exclude<CardListEntry, { kind: 'card' }>): HTMLElement {
    const { key, text } = headingShown(entry);
    const heading = headings.get(key) ?? doc.createElement('h2');
    headings.set(key, heading);
    heading.className = 'controller-group-heading';
    heading.textContent = text;
    return heading;
  }
  const empty = doc.createElement('p');
  empty.textContent = 'No terminals connected. Launch a terminal while the controller is running.';
  empty.tabIndex = -1;

  function mountCard(directory: ControllerDirectoryCard, timeText: string): ControllerCard {
    const { launchDirectory } = directory;
    return createControllerCard(list, {
      card: directory,
      expandedByDefault: expandedFor(directory),
      timeText,
      held: held.has(launchDirectory),
      onClearHistory(target) {
        alert.replaceChildren();
        return deps.controller.clearHistory(target).then(outcome => {
          if (disposed || outcome === 'cleared') return;
          alert.replaceChildren();
          alert.textContent = outcome === 'stale'
            ? 'History changed. Review the current history and retry Clear history.'
            : 'Clear history unavailable. Please retry.';
        }).catch(announce);
      },
      onAction(current) {
        if (current.kind === 'disconnected') return deps.controller.dismissTerminal(current.dismissOccurrenceId).catch(announce);
        const request = ++activation;
        const targets = current.activationTargets;
        alert.replaceChildren();
        return Promise.all(targets.map(async id => {
          try { return await deps.controller.activateTerminal(id); }
          catch { return 'unavailable' as const; }
        })).then(outcomes => {
          if (disposed || request !== activation) return;
          const failed = outcomes.filter(outcome => outcome === 'unavailable').length;
          if (failed) {
            alert.replaceChildren();
            alert.textContent = `Terminal unavailable: ${failed} of ${targets.length} activation attempts unavailable or unconfirmed.`;
          }
        });
      },
      onDismissLoopMessage(id, current) {
        if (current.kind !== 'single') return;
        return deps.controller.dismissLoopMessage(current.activationTargets[0], id).catch(announce);
      },
      onUse() {
        recency.set(launchDirectory, ++uses);
        if (!held.size) renderList();
      },
    });
  }

  function currentHolds(): Set<string> {
    const present = new Set(directories.map(({ launchDirectory }) => launchDirectory));
    const holds = new Set<string>();
    if (pointerOver !== undefined && present.has(pointerOver)) holds.add(pointerOver);
    const focused = deps.windowFocus.focused() ? [...cards.values()].find(({ card }) => card.contains(focusedNode)) : undefined;
    if (focused && present.has(focused.directory.launchDirectory)) holds.add(focused.directory.launchDirectory);
    return holds;
  }

  function refreshHolds(): void {
    if (disposed) return;
    const wasFrozen = held.size > 0;
    held = currentHolds();
    if (wasFrozen && !held.size) renderList();
    else for (const { directory, card } of cards.values()) card.setHeld(held.has(directory.launchDirectory));
  }

  const nodeOf = (target: EventTarget | null): Node | null => (target instanceof Node && host.contains(target) ? target : null);
  /** Read from the event, not `activeElement`: between a native `focusout` and its `focusin`, focus is on the body. */
  const focusMoved = (event: FocusEvent) => {
    focusedNode = nodeOf(event.type === 'focusin' ? event.target : event.relatedTarget);
    refreshHolds();
  };
  const pointerMoved = (event: PointerEvent) => {
    const target = event.target instanceof Node ? event.target : null;
    pointerOver = [...cards.values()].find(({ card }) => card.contains(target))?.directory.launchDirectory;
    refreshHolds();
  };
  const pointerLeft = () => {
    pointerOver = undefined;
    refreshHolds();
  };
  host.addEventListener('pointerover', pointerMoved);
  host.addEventListener('pointerleave', pointerLeft);
  host.addEventListener('focusin', focusMoved);
  host.addEventListener('focusout', focusMoved);
  const unsubscribeWindowFocus = deps.windowFocus.onChange(refreshHolds);

  function showCard(directory: ControllerDirectoryCard, timeText: string): ControllerCard {
    const kept = cards.get(directory.launchDirectory);
    if (!kept) return mountCard(directory, timeText);
    if (kept.directory !== directory) {
      kept.card.update(directory);
      kept.card.setExpandedByDefault(expandedFor(directory));
    }
    kept.card.setTimeText(timeText);
    return kept.card;
  }

  function renderList(): void {
    if (disposed || !observed) return;
    const now = deps.clock.now();
    const next = new Map<string, { directory: ControllerDirectoryCard; card: ControllerCard }>();
    const nodes: Node[] = [];
    for (const entry of order.list(sortMode, recency, held.size > 0)) {
      if (entry.kind !== 'card') {
        nodes.push(groupHeading(entry));
        continue;
      }
      const directory = entry.card;
      const card = showCard(directory, order.timeInState(directory, now));
      next.set(directory.launchDirectory, { directory, card });
      nodes.push(card.element());
    }
    if (!directories.length) nodes.push(empty);
    const fallback = () => [...next.values()][0]?.card.header() ?? (directories.length ? undefined : empty);
    reconcileChildren(list, nodes, fallback);
    const previous = cards;
    cards = next;
    for (const [launchDirectory, { card }] of previous) if (!next.has(launchDirectory)) card.dispose();
    refreshHolds();
  }

  const unsubscribe = deps.controller.subscribeTerminals(snapshot => {
    directories = directoryCards(snapshot);
    const present = new Set(directories.map(({ launchDirectory }) => launchDirectory));
    for (const directory of recency.keys()) if (!present.has(directory)) recency.delete(directory);
    if (pointerOver !== undefined && !present.has(pointerOver)) pointerOver = undefined;
    held = currentHolds();
    order.observe(directories, deps.clock.now());
    observed = true;
    announceAttention(directories);
    header.render(directories);
    renderList();
  });
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      unsubscribeLayout();
      unsubscribeClock();
      unsubscribeWindowFocus();
      host.removeEventListener('pointerover', pointerMoved);
      host.removeEventListener('pointerleave', pointerLeft);
      host.removeEventListener('focusin', focusMoved);
      host.removeEventListener('focusout', focusMoved);
      alwaysOnTopControl.dispose();
      themeToggle?.dispose();
      sortControl?.dispose();
      cards.forEach(({ card }) => card.dispose());
      host.replaceChildren();
      host.classList.remove('controller-panes');
      delete host.dataset.layout;
    },
  };
}
