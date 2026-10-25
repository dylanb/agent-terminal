import { cardStatus } from '../../shared/controllerCardStatus';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerTerminal, ControllerWorkStatus } from '../../shared/ipc';
import { createClampedReason, type ClampedReason } from './clampedReason';

export interface ControllerCardDeps {
  terminal: ControllerTerminal;
  fullReasons: ReadonlySet<string>;
  onReasonToggle(reason: string, full: boolean): void;
  onBringForward(): void;
  onDismiss(): void;
}

export interface ControllerCard {
  dispose(): void;
}

let nextHeadingId = 0;

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
  const headingId = `controller-card-heading-${nextHeadingId += 1}`;
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
  heading.append(element('span', 'controller-card-name', finalSegment(terminal.repositoryRoot ?? terminal.launchDirectory)), ' ', directory);
  header.append(accent, heading);

  const body = element('div', 'controller-card-body');
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

  function appendWork(work: ControllerWorkStatus): void {
    const muted = (text: string) => element('span', 'controller-muted', text);
    const ticket = element('p', 'controller-card-line controller-card-ticket');
    if (work.flow.availability === 'known' && work.flow.assignment === 'unassigned') ticket.append(muted('No flow run started'));
    else if (work.ticket.availability === 'known') {
      const title = work.ticket.title.availability === 'known'
        ? element('span', 'controller-card-title', work.ticket.title.text)
        : muted(work.ticket.title.availability === 'loading' ? 'Title loading' : 'Title unavailable');
      if (work.ticket.title.availability === 'known') title.title = work.ticket.title.text;
      ticket.append(element('span', 'controller-card-issue', `#${work.ticket.number}`), ' ', title);
    } else ticket.append(muted(work.ticket.availability === 'none' ? 'No ticket' : work.ticket.availability === 'loading' ? 'Ticket loading' : 'Ticket unavailable'));
    const flow = work.flow.availability === 'known'
      ? `Flow: ${work.flow.name} — Step: ${work.flow.step}`
      : work.flow.availability === 'loading' ? 'Flow loading' : 'Flow unavailable';
    const activity = work.activity === 'active' ? 'Active' : work.activity === 'quiet' ? 'Idle' : 'Activity unavailable';
    body.append(' ', ticket, ' ', element('p', 'controller-card-line', flow), ' ', element('p', 'controller-card-line', activity));
    if (work.attention) appendCondition('needs-human', `Human needed: ${work.attention.status}`, work.attention.reasons);
    if (work.error) appendCondition('error', 'Error', [work.error.reason]);
  }

  function appendCondition(statusClass: 'needs-human' | 'error', title: string, texts: readonly string[]): void {
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

  return {
    dispose() {
      reasons.forEach(reason => reason.dispose());
      card.remove();
    },
  };
}
