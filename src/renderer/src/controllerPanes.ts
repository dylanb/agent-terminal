import { cardStatus, SUMMARY_CLASS, SUMMARY_LABELS, type CardStatusClass } from '../../shared/controllerCardStatus';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import { captureSubtreeFocus } from './dom';
import { CONTROLLER_DEFAULT_THEME, type ControllerApi, type ControllerTerminal, type Theme } from '../../shared/ipc';
import { createControllerCard, workConditions, type ControllerCard } from './controllerCard';
import type { ControllerLayout } from './controllerFrame';
import { createThemeToggle } from './themeToggle';

export interface ControllerPanesDeps {
  controller: ControllerApi;
  layout: ControllerLayout;
  applyTheme(theme: Theme): void;
}

const HEADER = '[data-control="header"]';
const EXPANDED_IN_ONE_COLUMN: ReadonlySet<CardStatusClass> = new Set(['error', 'needs-human']);

function windowHeader(doc: Document): { element: HTMLElement; render(terminals: readonly ControllerTerminal[]): void } {
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
      const classified = terminals.map(cardStatus);
      counts.replaceChildren(...items([
        [`${terminals.length} ${terminals.length === 1 ? 'terminal' : 'terminals'}`],
        [`${terminals.length - disconnected} connected`],
        [`${disconnected} disconnected`],
      ]));
      summary.replaceChildren(...items(SUMMARY_LABELS.map(label =>
        [`${classified.filter(status => status.summary === label).length} ${label}`, SUMMARY_CLASS[label]] as [string, string]),
      ));
    },
  };
}

export function createControllerPanes(host: HTMLElement, deps: ControllerPanesDeps): { dispose(): void } {
  let disposed = false;
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
  let cards: { terminal: ControllerTerminal; card: ControllerCard }[] = [];
  const fullReasons = new Map<string, Set<string>>();
  const toggled = new Map<string, boolean>();
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

  const expandedFor = (terminal: ControllerTerminal): boolean => toggled.get(terminal.id)
    ?? (!deps.layout.oneColumn() || EXPANDED_IN_ONE_COLUMN.has(cardStatus(terminal).statusClass));
  const applyLayout = () => { host.dataset.layout = deps.layout.oneColumn() ? 'one-column' : 'multi-column'; };
  applyLayout();
  const unsubscribeLayout = deps.layout.onChange(() => {
    applyLayout();
    for (const { terminal, card } of cards) card.setExpanded(expandedFor(terminal));
  });

  const announce = () => {
    if (disposed) return;
    alert.replaceChildren();
    alert.textContent = 'Terminal unavailable';
  };

  function announceAttention(terminals: readonly ControllerTerminal[]): void {
    const currentAttention = new Map<string, string>();
    const announcements: string[] = [];
    for (const terminal of terminals) {
      if (terminal.status === 'disconnected') continue;
      const work = terminal.work;
      const text = work?.unavailableReason ? CONTROLLER_OVERSIZED_STATUS_TEXT : [
        ...(work?.attention ? [`Human needed: ${work.attention.status}`, ...work.attention.reasons] : []),
        ...(work?.error ? [`Error: ${work.error.reason}`] : []),
      ].join('. ');
      currentAttention.set(terminal.id, text);
      if (text !== (previousAttention.get(terminal.id) ?? '')) {
        announcements.push(`${terminal.launchDirectory}: ${text || (previousAttention.get(terminal.id) === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared')}`);
      }
    }
    if (announcements.length || [...previousAttention.keys()].some(id => !currentAttention.has(id))) {
      status.textContent = announcements.join('\n');
    }
    previousAttention = currentAttention;
  }

  function keepReasons(terminals: readonly ControllerTerminal[]): void {
    const current = new Map(terminals.map(terminal => [terminal.id, new Set(workConditions(terminal.work).flatMap(condition => condition.reasons))]));
    for (const [id, shown] of fullReasons) {
      const reasons = current.get(id);
      for (const reason of shown) if (!reasons?.has(reason)) shown.delete(reason);
      if (!shown.size) fullReasons.delete(id);
    }
  }

  const unsubscribe = deps.controller.subscribeTerminals(terminals => {
    announceAttention(terminals);
    keepReasons(terminals);
    header.render(terminals);
    const restoreFocus = captureSubtreeFocus(list);
    const focused = doc.activeElement instanceof HTMLElement && list.contains(doc.activeElement) ? doc.activeElement : null;
    const focusedId = focused?.closest<HTMLElement>('article')?.dataset.terminalId;
    const focusedControl = focused?.dataset.control;
    const focusedReason = focused?.closest<HTMLElement>('[data-reason]')?.dataset.reason;
    cards.forEach(({ card }) => card.dispose());
    list.replaceChildren();
    cards = terminals.map(terminal => ({ terminal, card: createControllerCard(list, {
      terminal,
      expanded: expandedFor(terminal),
      onToggle(expanded) { toggled.set(terminal.id, expanded); },
      fullReasons: fullReasons.get(terminal.id) ?? new Set(),
      onReasonToggle(reason, full) {
        const shown = fullReasons.get(terminal.id) ?? new Set<string>();
        if (full) shown.add(reason);
        else shown.delete(reason);
        if (shown.size) fullReasons.set(terminal.id, shown);
        else fullReasons.delete(terminal.id);
      },
      onBringForward() {
        void deps.controller.activateTerminal(terminal.id).then(outcome => {
          if (outcome === 'unavailable') announce();
        }, announce);
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
    restoreFocus(() => {
      const card = [...list.querySelectorAll<HTMLElement>('article')].find(element => element.dataset.terminalId === focusedId);
      const controls = card ? [...card.querySelectorAll<HTMLElement>('[data-control]')] : [];
      return controls.find(control => control.dataset.control === focusedControl && !control.closest('[hidden]')
        && control.closest<HTMLElement>('[data-reason]')?.dataset.reason === focusedReason)
        ?? card?.querySelector<HTMLElement>(HEADER) ?? list.querySelector<HTMLElement>(HEADER) ?? list.querySelector('p');
    });
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
