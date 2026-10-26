import { cardStatus } from '../../shared/controllerCardStatus';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerTerminal, ControllerWorkStatus } from '../../shared/ipc';
import { createClampedReason, type ClampedReason } from './clampedReason';

export interface ControllerCardDeps {
  terminal: ControllerTerminal;
  expanded: boolean;
  onToggle(expanded: boolean): void;
  fullReasons: ReadonlySet<string>;
  onReasonToggle(reason: string, full: boolean): void;
  onBringForward(): void;
  onDismiss(): void;
}

export interface ControllerCard {
  setExpanded(expanded: boolean): void;
  dispose(): void;
}

export interface WorkCondition {
  statusClass: 'needs-human' | 'error';
  title: string;
  reasons: readonly string[];
}

export function workConditions(work: ControllerWorkStatus | undefined): WorkCondition[] {
  return [
    ...(work?.attention ? [{ statusClass: 'needs-human' as const, title: `Human needed: ${work.attention.status}`, reasons: work.attention.reasons }] : []),
    ...(work?.error ? [{ statusClass: 'error' as const, title: 'Error', reasons: [work.error.reason] }] : []),
  ];
}

const TICKET_TEXT = { none: 'No ticket', loading: 'Ticket loading', unavailable: 'Ticket unavailable' } as const;
const TITLE_TEXT = { loading: 'Title loading', unavailable: 'Title unavailable' } as const;
const FLOW_TEXT = { loading: 'Flow loading', unavailable: 'Flow unavailable' } as const;
const ACTIVITY_TEXT: Readonly<Record<ControllerWorkStatus['activity'], string>> = {
  active: 'Active', quiet: 'Idle', unavailable: 'Activity unavailable',
};

let nextCardId = 0;

function finalSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function createControllerCard(host: HTMLElement, deps: ControllerCardDeps): ControllerCard {
  const { terminal } = deps;
  const doc = host.ownerDocument;
  const status = cardStatus(terminal);
  const reasons: ClampedReason[] = [];
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const created = doc.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  const card = element('article', 'controller-card');
  card.dataset.terminalId = terminal.id;
  card.dataset.status = status.statusClass;
  if (terminal.status === 'disconnected') card.classList.add('is-disconnected');
  const cardId = `controller-card-${nextCardId += 1}`;
  const headingId = `${cardId}-heading`;
  card.setAttribute('aria-labelledby', headingId);

  const header = element('header', 'controller-card-header');
  const accent = element('span', 'controller-card-accent');
  accent.dataset.testid = 'card-accent';
  const heading = element('h2', 'controller-card-heading');
  heading.id = headingId;
  const directory = element('span', 'controller-card-directory mono');
  directory.title = terminal.launchDirectory;
  const directoryText = element('bdi', '', terminal.launchDirectory);
  directoryText.dir = 'ltr';
  directory.append(directoryText);
  const label = element('span', 'controller-card-label', status.text);
  const toggle = element('button', 'controller-card-toggle');
  toggle.type = 'button';
  toggle.dataset.control = 'header';
  toggle.setAttribute('aria-controls', `${cardId}-body`);
  toggle.append(element('span', 'controller-card-name', finalSegment(terminal.repositoryRoot ?? terminal.launchDirectory)), ' ', directory);
  heading.append(toggle);
  header.append(accent, heading);

  const body = element('div', 'controller-card-body');
  body.id = `${cardId}-body`;
  const statusRow = element('p', 'controller-card-status', status.text);
  statusRow.dataset.testid = 'card-status';
  body.append(statusRow);
  card.append(header, ' ', body);
  host.append(card);

  const action = (control: string, label: string, name: string, use: () => void) => {
    const button = element('button', 'controller-card-action', label);
    button.type = 'button';
    button.dataset.control = control;
    button.setAttribute('aria-label', `${name} ${terminal.launchDirectory}`);
    button.addEventListener('click', use);
    return button;
  };

  if (terminal.status === 'disconnected') {
    body.append(' ', action('dismiss', 'Dismiss', 'Dismiss disconnected terminal', deps.onDismiss));
  } else {
    if (terminal.work?.unavailableReason) body.append(' ', element('p', 'controller-card-line', CONTROLLER_OVERSIZED_STATUS_TEXT));
    else if (terminal.work) appendWork(terminal.work);
    body.append(' ', action('bring-forward', 'Bring forward', 'Bring forward', deps.onBringForward));
  }

  function ticketLine(work: ControllerWorkStatus): HTMLElement {
    const line = element('p', 'controller-card-line controller-card-ticket');
    const muted = (text: string) => element('span', 'controller-muted', text);
    if (work.flow.availability === 'known' && work.flow.assignment === 'unassigned') line.append(muted('No flow run started'));
    else if (work.ticket.availability !== 'known') line.append(muted(TICKET_TEXT[work.ticket.availability]));
    else {
      const { title } = work.ticket;
      const titleText = title.availability === 'known' ? element('span', 'controller-card-title', title.text) : muted(TITLE_TEXT[title.availability]);
      if (title.availability === 'known') titleText.title = title.text;
      line.append(element('span', 'controller-card-issue', `#${work.ticket.number}`), ' ', titleText);
    }
    return line;
  }

  function appendWork(work: ControllerWorkStatus): void {
    const flow = work.flow.availability === 'known' ? `Flow: ${work.flow.name} — Step: ${work.flow.step}` : FLOW_TEXT[work.flow.availability];
    body.append(' ', ticketLine(work), ' ', element('p', 'controller-card-line', flow), ' ', element('p', 'controller-card-line', ACTIVITY_TEXT[work.activity]));
    for (const condition of workConditions(work)) appendCondition(condition);
  }

  function appendCondition({ statusClass, title, reasons: texts }: WorkCondition): void {
    const box = element('section', `controller-condition controller-condition-${statusClass}`);
    box.append(element('p', 'controller-condition-title', title), ' ');
    body.append(' ', box);
    for (const text of texts) {
      reasons.push(createClampedReason(box, {
        text,
        full: deps.fullReasons.has(text),
        onToggle: full => deps.onReasonToggle(text, full),
      }));
    }
  }

  let expanded = deps.expanded;
  function setExpanded(next: boolean): void {
    const held = body.contains(doc.activeElement);
    expanded = next;
    toggle.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    if (expanded) label.remove();
    else toggle.append(label);
    if (held && !expanded) toggle.focus();
  }
  setExpanded(expanded);
  toggle.addEventListener('click', () => {
    setExpanded(!expanded);
    deps.onToggle(expanded);
  });

  return {
    setExpanded,
    dispose() {
      reasons.forEach(reason => reason.dispose());
      card.remove();
    },
  };
}
