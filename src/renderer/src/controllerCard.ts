import { ACTIVITY_WORDS, cardStatus } from '../../shared/controllerCardClassification';
import { workConditions, type WorkCondition } from './controllerCardConditions';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerWorkStatus } from '../../shared/ipc';
import type { ControllerDirectoryCard } from '../../shared/controllerCards';
import { createClampedReason, type ClampedReason } from './clampedReason';
import { createPressGroup, onPress, type PressGroup } from './pressable';

export interface ControllerCardDeps {
  card: ControllerDirectoryCard;
  expandedByDefault: boolean;
  timeText: string;
  held?: boolean;
  onAction(): void | Promise<unknown>;
  onClearHistory?(): void | Promise<unknown>;
  onDismissLoopMessage(id: string): void | Promise<unknown>;
  /** The operator pressed one of the card's own controls and the control accepted the press. */
  onUse?(): void;
  from?: CardState;
}

type Action = 'bring-forward' | 'dismiss' | 'dismiss-loop-message';
type Focus = 'header' | 'clear' | Action | { reason: string };
const HANDOVER = Symbol('controller card handover');

export interface CardState {
  readonly [HANDOVER]: { disconnected: boolean; chosenExpanded: boolean | undefined; fullReasons: ReadonlySet<string>; focused: Focus | undefined; actions: PressGroup };
}

export interface ControllerCard {
  setExpandedByDefault(expanded: boolean): void;
  setTimeText(text: string): void;
  setHeld(held: boolean): void;
  contains(node: Node | null): boolean;
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
  const actions = carried?.actions ?? createPressGroup();
  const reasons: { text: string; reason: ClampedReason }[] = [];
  const fullReasons = new Set<string>();
  const use = (): void => deps.onUse?.();
  const used = (pressed: () => unknown) => (): unknown => {
    use();
    return pressed();
  };
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
    const created = doc.createElement(tag);
    created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  };
  const icon = (path: string): SVGSVGElement => {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const drawn = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    drawn.setAttribute('d', path);
    svg.append(drawn);
    return svg;
  };

  const card = element('article', 'controller-card');
  card.dataset.status = status.statusClass;
  if (model.kind === 'disconnected') card.classList.add('is-disconnected');
  const cardId = `controller-card-${nextCardId += 1}`;
  const headingId = `${cardId}-heading`;
  const toggleId = `${cardId}-toggle`;
  const directoryId = `${cardId}-directory`;
  card.setAttribute('aria-labelledby', `${headingId} ${directoryId}`);

  const header = element('header', 'controller-card-header');
  const accent = element('span', 'controller-card-accent');
  accent.dataset.testid = 'card-accent';
  const heading = element('h3', 'controller-card-heading');
  heading.id = headingId;
  const directory = element('p', 'controller-card-directory mono');
  directory.id = directoryId;
  directory.title = model.launchDirectory;
  const directoryText = element('bdi', '', model.launchDirectory);
  directoryText.dir = 'ltr';
  directory.append(directoryText);
  const statusLabel = element('span', 'controller-card-label');
  let timeText = deps.timeText;
  let held = deps.held ?? false;
  const showStatus = () => { statusLabel.textContent = `${statusText} · ${timeText}${held ? ' · position held' : ''}`; };
  showStatus();
  const toggle = element('button', 'controller-card-toggle');
  toggle.type = 'button';
  toggle.id = toggleId;
  toggle.setAttribute('aria-controls', `${cardId}-body`);
  toggle.setAttribute('aria-labelledby', `${toggleId} ${directoryId}`);
  const repositoryName = finalSegment(model.repositoryRoot ?? model.launchDirectory);
  toggle.append(element('span', 'controller-card-name', repositoryName));
  for (const text of model.kind === 'single' ? [work?.title, work?.branch] : []) {
    if (text) toggle.append(' · ', element('span', 'controller-card-identity', text));
  }
  toggle.append(statusLabel);
  heading.append(toggle);
  header.append(accent, heading);

  const body = element('div', 'controller-card-body');
  body.id = `${cardId}-body`;
  const statusRow = element('p', 'controller-card-status', statusText);
  statusRow.dataset.testid = 'card-status';
  body.append(directory, ' ', statusRow);
  card.append(header, ' ', body);
  host.append(card);

  let loopMessageDismiss: HTMLButtonElement | undefined;
  const actionKind: Action = model.kind === 'disconnected' ? 'dismiss' : 'bring-forward';
  const action = (label: string, name: string, pressed: () => unknown) => {
    const button = element('button', 'controller-card-action', label);
    button.type = 'button';
    button.setAttribute('aria-label', `${name} ${model.launchDirectory}`);
    actions.bind(button, used(pressed), { key: name });
    return button;
  };

  let actionButton: HTMLButtonElement;
  if (actionKind === 'dismiss') {
    actionButton = action('Dismiss', 'Dismiss disconnected terminal', deps.onAction);
  } else {
    if (duplicate) body.append(' ', element('p', 'controller-card-line', 'Bring the terminals forward and close extra instances so only one remains.'));
    else if (work?.unavailableReason) body.append(' ', element('p', 'controller-card-line', CONTROLLER_OVERSIZED_STATUS_TEXT));
    else if (work) appendWork(work);
    const label = count > 1 ? `Bring all ${count} terminals forward` : 'Bring forward';
    actionButton = element('button', 'controller-card-bring');
    actionButton.type = 'button';
    actionButton.title = count > 1 ? 'Bring all of these terminals forward' : 'Bring this terminal forward';
    actionButton.setAttribute('aria-label', `${label} ${repositoryName} ${model.launchDirectory}`);
    actionButton.append(icon('M7 17L17 7M9 7h8v8'));
    actions.bind(actionButton, used(deps.onAction), { key: actionKind });
    header.append(actionButton);
  }
  if (actionKind === 'dismiss') body.append(' ', actionButton);
  const timeline = model.kind === 'conflict' ? [] : model.timeline ?? [];
  let clear: HTMLButtonElement | undefined;
  if (timeline.length) {
    const entries = element('ol', 'controller-timeline');
    for (const entry of timeline) {
      const item = element('li', `controller-timeline-entry controller-timeline-${entry.kind}`);
      if (entry.kind === 'notification') {
        const bell = icon('M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4');
        bell.classList.add('controller-notification-bell');
        item.append(bell, element('span', 'controller-visually-hidden', 'Notification: '));
      }
      const time = element('time', 'controller-muted', new Date(entry.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
      time.dateTime = new Date(entry.receivedAt).toISOString();
      item.append(element('span', 'controller-timeline-text', entry.kind === 'notification' ? entry.message : entry.text), ' ', time);
      if (entry.kind === 'notification' && entry.count > 1) item.append(' ', element('span', 'controller-muted', `${entry.count} arrivals`));
      entries.append(item);
    }
    body.append(' ', entries);
    clear = deps.onClearHistory ? action('Clear history', 'Clear history for', deps.onClearHistory) : undefined;
    if (clear) body.append(' ', clear);
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
    body.append(' ', ticketLine(work), ' ', element('p', 'controller-card-line', flow), ' ', element('p', 'controller-card-line', ACTIVITY_WORDS[work.activity]));
    for (const condition of workConditions(work)) appendCondition(condition);
  }

  function appendCondition({ statusClass, title, reasons: texts, loopMessageId }: WorkCondition): void {
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
          use();
        },
      }) });
    }
    if (loopMessageId !== undefined) {
      loopMessageDismiss = action('Dismiss', `Dismiss ${title.toLowerCase()}`, () => deps.onDismissLoopMessage(loopMessageId));
      box.append(' ', loopMessageDismiss);
    }
  }

  let chosenExpanded = carried?.disconnected && model.kind !== 'disconnected' ? undefined : carried?.chosenExpanded;
  let expanded = chosenExpanded ?? deps.expandedByDefault;
  function setExpanded(next: boolean): void {
    const focusInBody = body.contains(doc.activeElement);
    expanded = next;
    toggle.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    if (focusInBody && !expanded) toggle.focus();
  }
  setExpanded(expanded);
  onPress(toggle, () => {
    chosenExpanded = !expanded;
    setExpanded(chosenExpanded);
    use();
  });

  function focused(): Focus | undefined {
    const active = doc.activeElement;
    if (active === toggle) return 'header';
    if (clear && active === clear) return 'clear';
    if (active === actionButton) return actionKind;
    if (active && active === loopMessageDismiss) return 'dismiss-loop-message';
    const reason = reasons.find(({ reason }) => reason.control() === active);
    return reason && { reason: reason.text };
  }

  function shown(want: Focus): HTMLElement | undefined {
    if (want === 'header') return toggle;
    if (want === 'bring-forward') return actionKind === 'bring-forward' ? actionButton : undefined;
    if (body.hidden) return undefined;
    if (want === 'clear') return clear;
    if (typeof want !== 'string') return reasons.find(({ text, reason }) => text === want.reason && reason.control())?.reason.control();
    if (want === 'dismiss-loop-message') return loopMessageDismiss;
    return want === actionKind ? actionButton : undefined;
  }

  return {
    setExpandedByDefault(next) {
      if (chosenExpanded === undefined) setExpanded(next);
    },
    setTimeText(text) {
      timeText = text;
      showStatus();
    },
    setHeld(next) {
      held = next;
      showStatus();
    },
    contains: node => card.contains(node),
    state: () => ({ [HANDOVER]: { disconnected: model.kind === 'disconnected', chosenExpanded, fullReasons: new Set(fullReasons), focused: focused(), actions } }),
    focusTarget: () => (carried?.focused ? shown(carried.focused) ?? toggle : undefined),
    header: () => toggle,
    dispose() {
      reasons.forEach(({ reason }) => reason.dispose());
      card.remove();
    },
  };
}
