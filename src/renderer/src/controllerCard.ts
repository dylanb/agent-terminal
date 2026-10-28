import { ACTIVITY_WORDS, cardStatus } from '../../shared/controllerCardClassification';
import { workConditions, type WorkCondition } from './controllerCardConditions';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerWorkStatus } from '../../shared/ipc';
import type { ControllerDirectoryCard } from '../../shared/controllerCards';
import { createClampedReason, type ClampedReason } from './clampedReason';

export interface ControllerCardDeps {
  card: ControllerDirectoryCard;
  expandedByDefault: boolean;
  onAction(): void;
  from?: CardState;
}

type Action = 'bring-forward' | 'dismiss';
type Focus = 'header' | Action | { reason: string };
const HANDOVER = Symbol('controller card handover');

export interface CardState {
  readonly [HANDOVER]: { disconnected: boolean; chosenExpanded: boolean | undefined; fullReasons: ReadonlySet<string>; focused: Focus | undefined };
}

export interface ControllerCard {
  setExpandedByDefault(expanded: boolean): void;
  state(): CardState;
  focusTarget(): HTMLElement | undefined;
  header(): HTMLElement;
  dispose(): void;
}

const TICKET_TEXT = { none: 'No ticket', loading: 'Ticket loading', unavailable: 'Ticket unavailable' } as const;
const TITLE_TEXT = { loading: 'Title loading', unavailable: 'Title unavailable' } as const;
const FLOW_TEXT = { loading: 'Flow loading', unavailable: 'Flow unavailable' } as const;

let nextCardId = 0;

function finalSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function createControllerCard(host: HTMLElement, deps: ControllerCardDeps): ControllerCard {
  const { card: model } = deps;
  const doc = host.ownerDocument;
  const status = cardStatus(model);
  const count = model.kind === 'disconnected' ? 0 : model.activationTargets.length;
  const work = model.kind === 'single' ? model.work : undefined;
  const duplicate = model.kind === 'conflict';
  const statusText = duplicate ? `${status.text} · ${count} instances` : status.text;
  const carried = deps.from?.[HANDOVER];
  const reasons: { text: string; reason: ClampedReason }[] = [];
  const fullReasons = new Set<string>();
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const created = doc.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };

  const card = element('article', 'controller-card');
  card.dataset.status = status.statusClass;
  if (model.kind === 'disconnected') card.classList.add('is-disconnected');
  const cardId = `controller-card-${nextCardId += 1}`;
  const headingId = `${cardId}-heading`;
  card.setAttribute('aria-labelledby', headingId);

  const header = element('header', 'controller-card-header');
  const accent = element('span', 'controller-card-accent');
  accent.dataset.testid = 'card-accent';
  const heading = element('h2', 'controller-card-heading');
  heading.id = headingId;
  const directory = element('span', 'controller-card-directory mono');
  directory.title = model.launchDirectory;
  const directoryText = element('bdi', '', model.launchDirectory);
  directoryText.dir = 'ltr';
  directory.append(directoryText);
  const statusLabel = element('span', 'controller-card-label', statusText);
  const toggle = element('button', 'controller-card-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', `${cardId}-body`);
  toggle.append(element('span', 'controller-card-name', finalSegment(model.repositoryRoot ?? model.launchDirectory)), ' ', directory);
  heading.append(toggle);
  header.append(accent, heading);

  const body = element('div', 'controller-card-body');
  body.id = `${cardId}-body`;
  const statusRow = element('p', 'controller-card-status', statusText);
  statusRow.dataset.testid = 'card-status';
  body.append(statusRow);
  card.append(header, ' ', body);
  host.append(card);

  const actionKind: Action = model.kind === 'disconnected' ? 'dismiss' : 'bring-forward';
  const action = (label: string, name: string, use: () => void) => {
    const button = element('button', 'controller-card-action', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${name} ${model.launchDirectory}`);
    button.addEventListener('click', use);
    return button;
  };

  let actionButton: HTMLButtonElement;
  if (actionKind === 'dismiss') {
    actionButton = action('Dismiss', 'Dismiss disconnected terminal', deps.onAction);
  } else {
    if (duplicate) body.append(' ', element('p', 'controller-card-line', 'Bring the terminals forward and close extra instances so only one remains.'));
    else if (work?.unavailableReason) body.append(' ', element('p', 'controller-card-line', CONTROLLER_OVERSIZED_STATUS_TEXT));
    else if (work) appendWork(work);
    const label = count === 2 ? 'Bring both forward' : count > 2 ? `Bring ${count} terminals forward` : 'Bring forward';
    actionButton = action(label, `${label} ${finalSegment(model.repositoryRoot ?? model.launchDirectory)}`, deps.onAction);
  }
  body.append(' ', actionButton);

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
    body.append(' ', ticketLine(work), ' ', element('p', 'controller-card-line', flow), ' ', element('p', 'controller-card-line', ACTIVITY_WORDS[work.activity]));
    for (const condition of workConditions(work)) appendCondition(condition);
  }

  function appendCondition({ statusClass, title, reasons: texts }: WorkCondition): void {
    const box = element('section', `controller-condition controller-condition-${statusClass}`);
    box.append(element('p', 'controller-condition-title', title), ' ');
    body.append(' ', box);
    for (const text of texts) {
      if (carried?.fullReasons.has(text)) fullReasons.add(text);
      reasons.push({ text, reason: createClampedReason(box, {
        text,
        full: fullReasons.has(text),
        onToggle(full) {
          if (full) fullReasons.add(text);
          else fullReasons.delete(text);
        },
      }) });
    }
  }

  let chosenExpanded = carried?.disconnected && model.kind !== 'disconnected' ? undefined : carried?.chosenExpanded;
  let expanded = chosenExpanded ?? deps.expandedByDefault;
  function setExpanded(next: boolean): void {
    const held = body.contains(doc.activeElement);
    expanded = next;
    toggle.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    if (expanded) statusLabel.remove();
    else toggle.append(statusLabel);
    if (held && !expanded) toggle.focus();
  }
  setExpanded(expanded);
  toggle.addEventListener('click', () => {
    chosenExpanded = !expanded;
    setExpanded(chosenExpanded);
  });

  function focused(): Focus | undefined {
    const active = doc.activeElement;
    if (active === toggle) return 'header';
    if (active === actionButton) return actionKind;
    const reason = reasons.find(({ reason }) => reason.control() === active);
    return reason && { reason: reason.text };
  }

  function shown(want: Focus): HTMLElement | undefined {
    if (want === 'header') return toggle;
    if (body.hidden) return undefined;
    if (typeof want !== 'string') return reasons.find(({ text, reason }) => text === want.reason && reason.control())?.reason.control();
    return want === actionKind ? actionButton : undefined;
  }

  return {
    setExpandedByDefault(next) {
      if (chosenExpanded === undefined) setExpanded(next);
    },
    state: () => ({ [HANDOVER]: { disconnected: model.kind === 'disconnected', chosenExpanded, fullReasons: new Set(fullReasons), focused: focused() } }),
    focusTarget: () => (carried?.focused ? shown(carried.focused) ?? toggle : undefined),
    header: () => toggle,
    dispose() {
      reasons.forEach(({ reason }) => reason.dispose());
      card.remove();
    },
  };
}
