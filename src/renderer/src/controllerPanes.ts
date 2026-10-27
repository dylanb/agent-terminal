import { directoryCards, type ControllerDirectoryCard } from '../../shared/controllerCards';
import { attentionText, attentionUpdate, cardStatus, statusSummary, type CardStatusClass } from './controllerCardStatus';
import { captureSubtreeFocus } from './dom';
import { CONTROLLER_DEFAULT_THEME, type ControllerApi, type Theme } from '../../shared/ipc';
import { createControllerCard, type ControllerCard } from './controllerCard';
import type { ControllerLayout } from './controllerFrame';
import { createThemeToggle } from './themeToggle';

export interface ControllerPanesDeps {
  controller: ControllerApi;
  layout: ControllerLayout;
  applyTheme(theme: Theme): void;
}

const EXPANDED_IN_ONE_COLUMN: ReadonlySet<CardStatusClass> = new Set(['error', 'needs-human']);

function windowHeader(doc: Document): { element: HTMLElement; render(terminals: readonly ControllerDirectoryCard[]): void } {
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
    render(terminals) {
      const disconnected = terminals.filter(terminal => terminal.status === 'disconnected').length;
      counts.replaceChildren(...items([
        [`${terminals.length} ${terminals.length === 1 ? 'card' : 'cards'}`],
        [`${terminals.length - disconnected} connected`],
        [`${disconnected} disconnected`],
      ]));
      summary.replaceChildren(...items(statusSummary(terminals).map(({ label, statusClass, count }) => [`${count} ${label}`, statusClass] as [string, string])));
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
  let cards: { terminal: ControllerDirectoryCard; card: ControllerCard }[] = [];
  host.append(header.element, list, alert, status);
  let themeToggle: { dispose(): void } | undefined;
  void deps.controller.getTheme().catch((): Theme => CONTROLLER_DEFAULT_THEME).then(theme => {
    if (disposed) return;
    deps.applyTheme(theme);
    header.element.append(' ');
    themeToggle = createThemeToggle(header.element, {
      theme,
      onChange(next) {
        deps.applyTheme(next);
        void deps.controller.setTheme(next).catch(error => console.error(`Controller theme not saved: ${error instanceof Error ? error.message : String(error)}`));
      },
    });
  });

  const expandedFor = (terminal: ControllerDirectoryCard): boolean =>
    !deps.layout.oneColumn() || EXPANDED_IN_ONE_COLUMN.has(cardStatus(terminal).statusClass);
  const applyLayout = () => { host.dataset.layout = deps.layout.oneColumn() ? 'one-column' : 'multi-column'; };
  applyLayout();
  const unsubscribeLayout = deps.layout.onChange(() => {
    applyLayout();
    for (const { terminal, card } of cards) card.setExpandedByDefault(expandedFor(terminal));
  });

  const announce = () => {
    if (disposed) return;
    alert.replaceChildren();
    alert.textContent = 'Terminal unavailable';
  };

  function announceAttention(terminals: readonly ControllerDirectoryCard[]): void {
    const currentAttention = new Map<string, string>();
    const announcements: string[] = [];
    for (const terminal of terminals) {
      if (terminal.status === 'disconnected') continue;
      const text = terminal.instanceCount > 1 ? 'Duplicate directory' : attentionText(terminal);
      const key = terminal.launchDirectory;
      currentAttention.set(key, text);
      const previous = previousAttention.get(key) ?? '';
      const update = previous === 'Duplicate directory' && text !== previous
        ? `Duplicate directory cleared${text ? `. ${text}` : ''}` : attentionUpdate(previous, text);
      if (update) announcements.push(`${terminal.launchDirectory}: ${update}`);
    }
    for (const [directory, text] of previousAttention) {
      if (text === 'Duplicate directory' && !currentAttention.has(directory)) announcements.push(`${directory}: Duplicate directory cleared`);
    }
    if (announcements.length || [...previousAttention.keys()].some(id => !currentAttention.has(id))) {
      status.textContent = announcements.join('\n');
    }
    previousAttention = currentAttention;
  }

  const unsubscribe = deps.controller.subscribeTerminals(snapshot => {
    const terminals = directoryCards(snapshot);
    announceAttention(terminals);
    header.render(terminals);
    const restoreFocus = captureSubtreeFocus(list);
    const handover = new Map(cards.map(({ terminal, card }) => [terminal.launchDirectory, card.state()]));
    cards.forEach(({ card }) => card.dispose());
    list.replaceChildren();
    cards = terminals.map(terminal => ({ terminal, card: createControllerCard(list, {
      terminal,
      expandedByDefault: expandedFor(terminal),
      from: handover.get(terminal.launchDirectory),
      onBringForward() {
        const request = ++activation;
        const targets = terminal.liveIds;
        alert.replaceChildren();
        void Promise.all(targets.map(async id => {
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
      onDismiss() {
        void deps.controller.dismissTerminal(terminal.id).catch(announce);
      },
    }) }));
    if (!terminals.length) {
      const empty = doc.createElement('p');
      empty.textContent = 'No terminals connected. Launch a terminal while the controller is running.';
      empty.tabIndex = -1;
      list.append(empty);
    }
    restoreFocus(() => cards.map(({ card }) => card.focusTarget()).find(Boolean) ?? cards[0]?.card.header() ?? list.querySelector('p'));
  });
  return {
    dispose() {
      disposed = true;
      unsubscribe();
      unsubscribeLayout();
      themeToggle?.dispose();
      cards.forEach(({ card }) => card.dispose());
      host.replaceChildren();
      host.classList.remove('controller-panes');
      delete host.dataset.layout;
    },
  };
}
