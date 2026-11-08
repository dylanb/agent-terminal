import { activityLine, cardStatus } from '../../shared/controllerCardClassification';
import { workConditions, type WorkCondition } from './controllerCardConditions';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerClearTarget, ControllerWorkStatus } from '../../shared/ipc';
import type { ControllerDirectoryCard } from '../../shared/controllerCards';
import { createClampedReason, type ClampedReason } from './clampedReason';
import { content, reconcileChildren, type Content } from './dom';
import { createPressGroup, onPress } from './pressable';

export interface ControllerCardDeps {
  card: ControllerDirectoryCard;
  expandedByDefault: boolean;
  timeText: string;
  held?: boolean;
  onAction(card: ControllerDirectoryCard): void | Promise<unknown>;
  onClearHistory?(target: ControllerClearTarget): void | Promise<unknown>;
  onDismissLoopMessage(id: string, card: ControllerDirectoryCard): void | Promise<unknown>;
  /** The operator pressed one of the card's own controls and the control accepted the press. */
  onUse?(): void;
}

type Action = 'bring-forward' | 'dismiss';

export interface ControllerCard {
  update(card: ControllerDirectoryCard): void;
  setExpandedByDefault(expanded: boolean): void;
  setTimeText(text: string): void;
  setHeld(held: boolean): void;
  contains(node: Node | null): boolean;
  element(): HTMLElement;
  header(): HTMLElement;
  dispose(): void;
}

const TICKET_TEXT = { none: 'No ticket', loading: 'Ticket loading', unavailable: 'Ticket unavailable' } as const;
const TITLE_TEXT = { loading: 'Title loading', unavailable: 'Title unavailable' } as const;
const FLOW_TEXT = { loading: 'Flow loading', unavailable: 'Flow unavailable' } as const;

let nextCardId = 0;

function keyedPool<V>(release: (item: V) => void = () => {}) {
  let shown = new Map<string, V[]>();
  let next = new Map<string, V[]>();
  return {
    take(key: string, create: () => V): V {
      const item = shown.get(key)?.shift() ?? create();
      next.set(key, [...(next.get(key) ?? []), item]);
      return item;
    },
    commit(): void {
      for (const left of shown.values()) left.forEach(release);
      [shown, next] = [next, new Map()];
    },
    values: () => [...shown.values()].flat(),
  };
}

function finalSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export function createControllerCard(host: HTMLElement, deps: ControllerCardDeps): ControllerCard {
  let model = deps.card;
  const doc = host.ownerDocument;
  const actions = createPressGroup();
  const reasons = keyedPool<ClampedReason>(reason => reason.dispose());
  const fullReasons = new Set<string>();
  const boxes = keyedPool<HTMLElement>();
  const loopDismissals = keyedPool<HTMLButtonElement>();
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
  const space = () => content(doc.createTextNode(' '));
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
  const directoryText = element('bdi', '');
  directoryText.dir = 'ltr';
  directory.append(directoryText);
  const statusLabel = element('span', 'controller-card-label');
  let statusText = '';
  let timeText = deps.timeText;
  let held = deps.held ?? false;
  const showStatus = () => { statusLabel.textContent = `${statusText} · ${timeText}${held ? ' · position held' : ''}`; };
  const toggle = element('button', 'controller-card-toggle');
  toggle.type = 'button';
  toggle.id = toggleId;
  toggle.setAttribute('aria-controls', `${cardId}-body`);
  toggle.setAttribute('aria-labelledby', `${toggleId} ${directoryId}`);
  heading.append(toggle);

  const body = element('div', 'controller-card-body');
  body.id = `${cardId}-body`;
  const statusRow = element('p', 'controller-card-status');
  statusRow.dataset.testid = 'card-status';
  card.append(header, ' ', body);
  host.append(card);

  const bringForward = element('button', 'controller-card-bring');
  bringForward.type = 'button';
  bringForward.append(icon('M7 17L17 7M9 7h8v8'));
  actions.bind(bringForward, used(() => deps.onAction(model)));
  const dismiss = element('button', 'controller-card-action', 'Dismiss');
  dismiss.type = 'button';
  actions.bind(dismiss, used(() => deps.onAction(model)));
  const clear = element('button', 'controller-card-action', 'Clear history');
  clear.type = 'button';
  const clearTarget = (): ControllerClearTarget | undefined => {
    switch (model.kind) {
      case 'single':
      case 'disconnected':
        return model.clearHistoryTarget;
      case 'conflict':
        return undefined;
      default:
        return model satisfies never;
    }
  };
  actions.bind(clear, used(() => {
    const target = clearTarget();
    return target && deps.onClearHistory?.(target);
  }));

  let wasDisconnected = model.kind === 'disconnected';
  let chosenExpanded: boolean | undefined;
  let expandedByDefault = deps.expandedByDefault;
  let expanded = expandedByDefault;
  const toToggle = () => toggle;

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

  function workLines(work: ControllerWorkStatus): HTMLElement[] {
    const flow = work.flow.availability === 'known' ? `Flow: ${work.flow.name} — Step: ${work.flow.step}` : FLOW_TEXT[work.flow.availability];
    return [ticketLine(work), element('p', 'controller-card-line', flow), element('p', 'controller-card-line', activityLine(work))];
  }

  function conditionBox({ statusClass, title, reasons: texts, loopMessageId }: WorkCondition): HTMLElement {
    const key = `${statusClass}\u0000${title}`;
    const box = boxes.take(key, () => {
      const created = element('section', `controller-condition controller-condition-${statusClass}`);
      body.append(created);
      return created;
    });
    const children: (Node | Content)[] = [content(element('p', 'controller-condition-title', title)), space()];
    for (const text of texts) {
      children.push(reasons.take(`${key}\u0000${text}`, () => createClampedReason(box, {
        text,
        full: fullReasons.has(text),
        onToggle(full) {
          if (full) fullReasons.add(text);
          else fullReasons.delete(text);
          use();
        },
      })).element());
    }
    if (loopMessageId !== undefined) {
      const button = loopDismissals.take(loopMessageId, () => {
        const created = element('button', 'controller-card-action', 'Dismiss');
        created.type = 'button';
        actions.bind(created, used(() => deps.onDismissLoopMessage(loopMessageId, model)));
        return created;
      });
      button.setAttribute('aria-label', `Dismiss ${title.toLowerCase()} ${model.launchDirectory}`);
      children.push(space(), button);
    }
    reconcileChildren(box, children, toToggle);
    return box;
  }

  function timelineList(timeline: NonNullable<Extract<ControllerDirectoryCard, { kind: 'single' }>['timeline']>): HTMLElement {
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
    return entries;
  }

  function render(): void {
    const status = cardStatus(model);
    const count = model.kind === 'disconnected' ? 0 : model.activationTargets.length;
    const work = model.kind === 'single' ? model.work : undefined;
    const duplicate = model.kind === 'conflict';
    statusText = duplicate ? `${status.text} · ${count} instances` : status.text;
    card.dataset.status = status.statusClass;
    card.classList.toggle('is-disconnected', model.kind === 'disconnected');
    directory.title = model.launchDirectory;
    directoryText.textContent = model.launchDirectory;
    statusRow.textContent = statusText;
    showStatus();

    const repositoryName = finalSegment(model.repositoryRoot ?? model.launchDirectory);
    const toggleParts: Content[] = [content(element('span', 'controller-card-name', repositoryName))];
    for (const text of model.kind === 'single' ? [work?.title, work?.branch] : []) {
      if (text) toggleParts.push(content(doc.createTextNode(' · ')), content(element('span', 'controller-card-identity', text)));
    }
    reconcileChildren(toggle, [...toggleParts, statusLabel]);

    const actionKind: Action = model.kind === 'disconnected' ? 'dismiss' : 'bring-forward';
    const label = count > 1 ? `Bring all ${count} terminals forward` : 'Bring forward';
    bringForward.title = count > 1 ? 'Bring all of these terminals forward' : 'Bring this terminal forward';
    bringForward.setAttribute('aria-label', `${label} ${repositoryName} ${model.launchDirectory}`);
    dismiss.setAttribute('aria-label', `Dismiss disconnected terminal ${model.launchDirectory}`);
    clear.setAttribute('aria-label', `Clear history for ${model.launchDirectory}`);
    reconcileChildren(header, actionKind === 'bring-forward' ? [accent, heading, bringForward] : [accent, heading], toToggle);

    let conditions: WorkCondition[] = [];
    const parts: (Node | Content)[] = [];
    if (actionKind === 'dismiss') parts.push(dismiss);
    else if (duplicate) parts.push(content(element('p', 'controller-card-line', 'Bring the terminals forward and close extra instances so only one remains.')));
    else if (work?.unavailableReason) parts.push(content(element('p', 'controller-card-line', CONTROLLER_OVERSIZED_STATUS_TEXT)));
    else if (work) {
      conditions = workConditions(work);
      parts.push(...workLines(work).map(content), ...conditions.map(condition => conditionBox(condition)));
    }
    const timeline = model.kind === 'conflict' ? [] : model.timeline ?? [];
    if (timeline.length) {
      parts.push(content(timelineList(timeline)));
      if (deps.onClearHistory && clearTarget()) parts.push(clear);
    }
    reconcileChildren(body, [directory, space(), statusRow, ...parts.flatMap(part => [space(), part])], toToggle);

    reasons.commit();
    boxes.commit();
    loopDismissals.commit();
    const shownTexts = new Set(conditions.flatMap(condition => condition.reasons));
    for (const text of fullReasons) if (!shownTexts.has(text)) fullReasons.delete(text);

    const disconnected = model.kind === 'disconnected';
    if (wasDisconnected && !disconnected) chosenExpanded = undefined;
    wasDisconnected = disconnected;
    setExpanded(chosenExpanded ?? expandedByDefault);
  }

  function setExpanded(next: boolean): void {
    const focusInBody = body.contains(doc.activeElement);
    expanded = next;
    toggle.setAttribute('aria-expanded', String(expanded));
    body.hidden = !expanded;
    if (focusInBody && !expanded) toggle.focus();
  }
  onPress(toggle, () => {
    chosenExpanded = !expanded;
    setExpanded(chosenExpanded);
    use();
  });
  render();

  return {
    update(next) {
      if (next.launchDirectory !== model.launchDirectory) throw new Error(`The card for ${model.launchDirectory} cannot show ${next.launchDirectory}`);
      model = next;
      render();
    },
    setExpandedByDefault(next) {
      expandedByDefault = next;
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
    element: () => card,
    header: () => toggle,
    dispose() {
      for (const reason of reasons.values()) reason.dispose();
      card.remove();
    },
  };
}
