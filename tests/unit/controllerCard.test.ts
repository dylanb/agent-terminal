// @vitest-environment jsdom
import { directoryCards } from '../../src/shared/controllerCards';
import { afterEach, describe, expect, it } from 'vitest';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../src/shared/controllerStatus';
import type { ControllerTerminal } from '../../src/shared/ipc';
import type { ControllerDirectoryCard } from '../../src/shared/controllerCards';
import { bodyActivationIn, bodyDirectoryIn, bringForwardIn, cardHeaderIn, cardHeaderTextIn, cardHeadingLevelsIn, cardIn, headerStatusIn, directoryPattern, headerActivationIn, headerRemainder, controlName, dismissIn, dismissLoopMessageIn, showsName, statusRowIn, clearHistoryIn, entryAccessibleText, entryIsNotification, entryTimesIn, historyIn, timelineEntriesIn } from '../helpers/controllerCards';
import { notificationItem, statusItem } from '../helpers/controllerHistory';
import { STATUS_CASES, statusTerminal, type WorkStatus } from '../helpers/controllerStatusFixture';

afterEach(() => document.body.replaceChildren());

const TIME_TEXT = 'for 3m';

function mount(terminal: ControllerTerminal, expanded = true) {
  const host = document.createElement('div');
  document.body.append(host);
  const calls = { bringForward: 0, dismiss: 0 };
  const loopMessageDismissals: string[] = [];
  const deps = {
    card: directoryCards([terminal])[0],
    expandedByDefault: expanded,
    timeText: TIME_TEXT,
    onAction() { calls[terminal.status === 'disconnected' ? 'dismiss' : 'bringForward'] += 1; },
    onDismissLoopMessage(id: string) { loopMessageDismissals.push(id); },
  };
  const card = createControllerCard(host, deps);
  return { host, calls, loopMessageDismissals, card, element: cardIn(host, terminal.launchDirectory) };
}

const withWork = (work: Partial<WorkStatus>): ControllerTerminal => statusTerminal(work);

function missingInOrder(text: string, texts: readonly string[]): string[] {
  let from = 0;
  return texts.flatMap(expected => {
    const at = text.indexOf(expected, from);
    if (at < 0) return [`"${expected}" missing after offset ${from}`];
    from = at + expected.length;
    return [];
  });
}

describe('controller card header', () => {
  it.each([
    ['the repository root', { id: 'r', launchDirectory: '/left/repo-root/worktrees/feature', repositoryRoot: '/left/repo-root' }, 'repo-root'],
    ['the launch directory when there is no root', { id: 'n', launchDirectory: '/tmp/scratch-dir', repositoryRoot: null }, 'scratch-dir'],
  ] as const)('names the card after the final segment of %s and shows the full directory', (_, terminal, name) => {
    const { element } = mount(terminal);
    expect({ card: Boolean(element), name: showsName(element, terminal.launchDirectory, name) }).toEqual({ card: true, name: true });
  });
});

describe('controller card header control', () => {
  it.each([true, false])('exposes expanded=%s on a header control named with the directory, its status then its time in state in the header', expanded => {
    const { terminal, text } = STATUS_CASES.working;
    const { element } = mount(terminal, expanded);
    const header = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    expect({ state: header?.getAttribute('aria-expanded'), label: element ? headerStatusIn(element, terminal.launchDirectory).endsWith(`${text} · ${TIME_TEXT}`) : false })
      .toEqual({ state: String(expanded), label: true });
  });

  it.each([true, false])('shows a duplicate-directory card\'s status, instance count and time in state in the header (expanded=%s)', expanded => {
    const host = document.createElement('div');
    document.body.append(host);
    const [a, b] = [STATUS_CASES.idle.terminal, { ...STATUS_CASES.idle.terminal, id: 'peer' }];
    createControllerCard(host, { card: directoryCards([a, b])[0], expandedByDefault: expanded, timeText: 'for 12m', onAction() {}, onDismissLoopMessage() {} });
    const element = cardIn(host, a.launchDirectory);
    expect(element ? headerStatusIn(element, a.launchDirectory) : 'no card').toMatch(/Duplicate directory · 2 instances · for 12m$/);
  });

  it('names the card with a level-3 heading', () => {
    const { element } = mount(STATUS_CASES.idle.terminal);
    expect(element ? cardHeadingLevelsIn(element) : 'no card').toEqual([3]);
  });

  it('shows a new time in state in place, keeping the card, its focus and its expanded state', () => {
    const { terminal, text } = STATUS_CASES['needs-human'];
    const { element, card } = mount(terminal, false);
    const header = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    header?.focus();
    card.setTimeText('waiting 1h 4m');
    const now = cardIn(document.body, terminal.launchDirectory);
    expect({
      label: now ? headerStatusIn(now, terminal.launchDirectory).endsWith(`${text} · waiting 1h 4m`) : false,
      focused: Boolean(header) && document.activeElement === header,
      expanded: header?.getAttribute('aria-expanded'),
    }).toEqual({ label: true, focused: true, expanded: 'false' });
  });

  it('collapses and expands the card on each header click, and never brings it forward', () => {
    const { terminal } = STATUS_CASES.working;
    const { element, calls } = mount(terminal);
    const header = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    const states = [1, 2].map(() => { header?.click(); return header?.getAttribute('aria-expanded'); });
    expect({ states, calls }).toEqual({ states: ['false', 'true'], calls: { bringForward: 0, dismiss: 0 } });
  });
});

describe('controller card body', () => {
  it('runs status, ticket, flow, activity and both condition boxes in order, with Bring forward available in the header', () => {
    const { terminal, text } = STATUS_CASES['flow-error-and-human'];
    const { element } = mount(terminal);
    const status = element ? statusRowIn(element)?.textContent?.trim() : undefined;
    expect([
      ...(status === text ? [] : [`status row reads ${status}`]),
      ...missingInOrder(element?.textContent ?? '', [
        text, '#219', 'Show live controller status', 'Flow: feature-dev — Step: implement', 'Idle',
        'Human needed: needs a human', 'Approve the plan', 'Error', 'Step exited 1',
      ]),
      ...(element && headerActivationIn(element) ? [] : ['Bring forward is missing from the header']),
      ...(element && bodyActivationIn(element) ? ['Bring forward is also in the body'] : []),
    ]).toEqual([]);
  });

  it.each([
    ['a loading title', withWork({ ticket: { availability: 'known', number: 219, title: { availability: 'loading' } } }), ['#219', 'Title loading']],
    ['an unavailable title', withWork({ ticket: { availability: 'known', number: 219, title: { availability: 'unavailable' } } }), ['#219', 'Title unavailable']],
    ['an unassigned terminal', STATUS_CASES.unassigned.terminal, ['No flow run started']],
    ['started work with no ticket', withWork({ ticket: { availability: 'none' } }), ['No ticket']],
    ['a loading ticket', withWork({ ticket: { availability: 'loading' } }), ['Ticket loading']],
    ['an unavailable ticket', withWork({ ticket: { availability: 'unavailable' } }), ['Ticket unavailable']],
    ['a loading flow', STATUS_CASES['flow-loading'].terminal, ['Flow loading']],
    ['an unavailable flow', STATUS_CASES['flow-unavailable'].terminal, ['Flow unavailable']],
  ] as const)('shows the alternative text for %s', (_, terminal, texts) => {
    const { element } = mount(terminal);
    expect(missingInOrder(element?.textContent ?? '', texts)).toEqual([]);
  });

  it.each([
    ['active', 'Working'], ['quiet', 'Idle'], ['unavailable', 'Activity unavailable'],
  ] as const)('reads the %s activity line, after the flow line, as %s', (activity, word) => {
    const { element } = mount(withWork({ activity, attention: { status: 'needs a human', reasons: ['Approve the plan'] } }));
    const text = element?.textContent ?? '';
    const flowLine = 'Flow: feature-dev — Step: implement';
    const afterFlow = text.slice(text.indexOf(flowLine) + flowLine.length);
    expect({ flowLine: text.includes(flowLine), activityLine: afterFlow.trimStart().slice(0, word.length) }).toEqual({ flowLine: true, activityLine: word });
  });

  it('shows the activity apart from the status text', () => {
    const { element } = mount(STATUS_CASES.idle.terminal);
    const status = element ? statusRowIn(element) : null;
    expect({ status: status?.textContent?.trim(), activity: missingInOrder(element?.textContent ?? '', ['Flow: feature-dev — Step: implement', 'Idle']) })
      .toEqual({ status: 'Idle', activity: [] });
  });

  it.each([
    ['Loading', STATUS_CASES.loading.terminal, [] as string[]],
    ['Status unavailable', STATUS_CASES.oversized.terminal, [CONTROLLER_OVERSIZED_STATUS_TEXT]],
  ] as const)('shows only the status row, any oversized message and Bring forward in %s', (status, terminal, extra) => {
    const { element } = mount(terminal);
    const text = (element?.textContent ?? '').replace(CONTROLLER_OVERSIZED_STATUS_TEXT, '');
    expect([
      ...(element ? [] : ['no card']),
      ...(element && statusRowIn(element)?.textContent?.trim() === status ? [] : ['wrong status row']),
      ...missingInOrder(element?.textContent ?? '', extra),
      ...(element && bringForwardIn(element) ? [] : ['no Bring forward']),
      ...['#', 'Ticket', 'No ticket', 'No flow run started', 'Flow', 'Working', 'Idle', 'Activity'].filter(line => text.includes(line)).map(line => `shows "${line}"`),
    ]).toEqual([]);
  });

  it('shows a disconnected card as Disconnected with no work details and Dismiss, which reports its use once', () => {
    const { terminal } = STATUS_CASES['disconnected-with-error'];
    const { element, calls } = mount(terminal);
    const dismiss = element ? dismissIn(element) : undefined;
    dismiss?.click();
    const text = element?.textContent ?? '';
    expect([
      ...(element ? [] : ['no card']),
      ...(element && statusRowIn(element)?.textContent?.trim() === 'Disconnected' ? [] : ['wrong status row']),
      ...['Step exited 1', 'Approve the plan', 'Human needed', '#219', 'Flow:', 'Working'].filter(detail => text.includes(detail)).map(detail => `shows "${detail}"`),
      ...(element && bringForwardIn(element) ? ['offers Bring forward'] : []),
      ...(dismiss && !dismiss.closest('header') ? [] : ['Dismiss is not in the body']),
      ...(controlName(dismiss).includes(terminal.launchDirectory) ? [] : ['Dismiss is not named with the directory']),
      ...(calls.dismiss === 1 && calls.bringForward === 0 ? [] : [`calls ${JSON.stringify(calls)}`]),
    ]).toEqual([]);
  });
});

describe('controller card launch directory', () => {
  const { terminal } = STATUS_CASES.working;
  const directory = terminal.launchDirectory;

  it.each([true, false])('keeps the directory out of the header text while the card and toggle names still hold it (expanded=%s)', expanded => {
    const { element } = mount(terminal, expanded);
    const toggle = element ? cardHeaderIn(element, directory) : undefined;
    expect({
      headerHoldsDirectory: element ? cardHeaderTextIn(element).includes(directory) : 'no card',
      toggleName: directoryPattern(directory).test(controlName(toggle)),
      cardName: directoryPattern(directory).test(controlName(element)),
    }).toEqual({ headerHoldsDirectory: false, toggleName: true, cardName: true });
  });

  it('shows the directory as text of the expanded body', () => {
    const { element } = mount(terminal, true);
    expect(Boolean(element && bodyDirectoryIn(element, directory))).toBe(true);
  });
});

describe('controller card bring-forward icon', () => {
  const terminal = statusTerminal();

  it.each([true, false])('sits in the header outside the disclosure toggle and leaves the body without a Bring forward button (expanded=%s)', expanded => {
    const { element } = mount(terminal, expanded);
    const icon = element ? headerActivationIn(element) : undefined;
    const toggle = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    expect({
      inHeader: Boolean(icon),
      outsideToggle: Boolean(icon && toggle && !toggle.contains(icon) && !icon.contains(toggle)),
      inBody: Boolean(element && bodyActivationIn(element)),
    }).toEqual({ inHeader: true, outsideToggle: true, inBody: false });
  });

  it.each([true, false])('is named with the repository and the full launch directory, and explains itself to pointer users (expanded=%s)', expanded => {
    const { element } = mount(terminal, expanded);
    const icon = element ? headerActivationIn(element) : undefined;
    expect({
      directory: directoryPattern(terminal.launchDirectory).test(controlName(icon)),
      repository: /\brepository\b/.test(controlName(icon)),
      tooltip: /bring/i.test(icon?.getAttribute('title') ?? ''),
    }).toEqual({ directory: true, repository: true, tooltip: true });
  });

  it('draws a decorative glyph that adds nothing to its name', () => {
    const { element } = mount(terminal, true);
    const icon = element ? headerActivationIn(element) : undefined;
    const shown = [...(icon?.children ?? [])];
    expect({
      icon: Boolean(icon),
      glyph: shown.length > 0,
      text: icon?.textContent?.trim() ?? '',
      hidden: shown.every(child => child.getAttribute('aria-hidden') === 'true'),
    }).toEqual({ icon: true, glyph: true, text: '', hidden: true });
  });

  it.each([true, false])('reports its use once and leaves the card as expanded or collapsed as it was (expanded=%s)', expanded => {
    const { element, calls } = mount(terminal, expanded);
    const icon = element ? headerActivationIn(element) : undefined;
    icon?.click();
    const toggle = element ? cardHeaderIn(element, terminal.launchDirectory) : undefined;
    expect({ icon: Boolean(icon), calls, expanded: toggle?.getAttribute('aria-expanded') })
      .toEqual({ icon: true, calls: { bringForward: 1, dismiss: 0 }, expanded: String(expanded) });
  });

  it('is not offered on a disconnected card, whose Dismiss stays in the body', () => {
    const { terminal: gone } = STATUS_CASES['disconnected-with-error'];
    const { element } = mount(gone);
    expect({ icon: Boolean(element && headerActivationIn(element)), dismissInBody: Boolean(element && dismissIn(element) && !dismissIn(element)?.closest('header')) })
      .toEqual({ icon: false, dismissInBody: true });
  });
});

describe('controller card loop message', () => {
  it.each([
    ['loop-error', 'Loop error', 'the turn stalled', 'Dismiss loop error'],
    ['loop-notice', 'Notice', 'nothing to commit', 'Dismiss notice'],
  ] as const)('shows the %s after the flow\'s conditions, with a Dismiss named for it and the directory that reports its message once', (key, title, reason, name) => {
    const terminal = STATUS_CASES[key].terminal;
    const { element, calls, loopMessageDismissals } = mount(terminal);
    const dismiss = element ? dismissLoopMessageIn(element) : undefined;
    dismiss?.click();
    expect([
      ...missingInOrder(element?.textContent ?? '', ['Flow: feature-dev — Step: implement', title, reason, 'Dismiss']),
      ...(controlName(dismiss).startsWith(name) && controlName(dismiss).includes(terminal.launchDirectory) ? [] : [`Dismiss is named ${controlName(dismiss)}`]),
      ...(element && bringForwardIn(element) ? [] : ['Bring forward is missing']),
      ...(calls.bringForward === 0 ? [] : ['brought forward']),
    ]).toEqual([]);
    expect(loopMessageDismissals).toEqual([(terminal.work as WorkStatus).loopMessage!.id]);
  });

  it('dismisses the newer message after an update replaces the loop message with one of the same kind and reason', () => {
    const terminal = STATUS_CASES['loop-error'].terminal;
    const work = terminal.work as WorkStatus;
    const { host, card, loopMessageDismissals } = mount(terminal);
    const newer: ControllerTerminal = { ...terminal, work: { ...work, loopMessage: { ...work.loopMessage!, id: 'newer-message' } } };
    card.update(directoryCards([newer])[0]);
    const element = cardIn(host, terminal.launchDirectory);
    (element ? dismissLoopMessageIn(element) : undefined)?.click();
    expect(loopMessageDismissals).toEqual(['newer-message']);
  });

  it('shows no loop message or its Dismiss when there is none', () => {
    const { element } = mount(STATUS_CASES.idle.terminal);
    expect(element && dismissLoopMessageIn(element)).toBeUndefined();
  });
});

describe('controller card action while its work is being answered', () => {
  const settle = (): Promise<void> => new Promise(done => setTimeout(done, 0));
  function mountPending(terminal: ControllerTerminal, host = document.body.appendChild(document.createElement('div'))) {
    const answers: Array<() => void> = [];
    const answer = () => new Promise<void>(done => { answers.push(done); });
    const card = createControllerCard(host, { card: directoryCards([terminal])[0], expandedByDefault: true, timeText: TIME_TEXT, onAction: answer, onDismissLoopMessage() {} });
    return { host, card, answers };
  }

  it.each([
    ['Bring forward', 'working', bringForwardIn],
    ['Dismiss', 'disconnected-with-error', dismissIn],
  ] as const)('%s ignores further presses and reports busy until its work is answered', async (_, statusCase, find) => {
    const { terminal } = STATUS_CASES[statusCase];
    const { host, answers } = mountPending(terminal);
    const card = cardIn(host, terminal.launchDirectory);
    const control = card ? find(card) : undefined;
    control?.click();
    control?.click();
    const pending = { dispatched: answers.length, busy: control?.getAttribute('aria-busy') ?? null };
    answers[0]?.();
    await settle();
    control?.click();
    expect({ pending, afterAnswer: answers.length }).toEqual({ pending: { dispatched: 1, busy: 'true' }, afterAnswer: 2 });
  });

  it('keeps Bring forward unavailable while its press is answered across an update, then takes the next press', async () => {
    const { terminal } = STATUS_CASES.working;
    const { host, card, answers } = mountPending(terminal);
    const first = cardIn(host, terminal.launchDirectory);
    (first && bringForwardIn(first))?.click();
    card.update(directoryCards([terminal])[0]);
    const updated = cardIn(host, terminal.launchDirectory);
    const control = updated ? bringForwardIn(updated) : undefined;
    control?.click();
    const pending = answers.length;
    answers[0]?.();
    await settle();
    control?.click();
    expect({ pending, afterAnswer: answers.length }).toEqual({ pending: 1, afterAnswer: 2 });
  });
});

describe('a controller card updated in place', () => {
  const pressed: ControllerDirectoryCard[] = [];
  function mountRecording(terminal: ControllerTerminal) {
    const host = document.createElement('div');
    document.body.append(host);
    pressed.length = 0;
    const card = createControllerCard(host, {
      card: directoryCards([terminal])[0], expandedByDefault: true, timeText: TIME_TEXT,
      onAction(current) { pressed.push(current); }, onDismissLoopMessage() {},
    });
    return { host, card };
  }

  it('reports a press with the directory the card shows now, after an update to it', () => {
    const { terminal } = STATUS_CASES.working;
    const { host, card } = mountRecording(terminal);
    card.update(directoryCards([terminal, { ...terminal, id: 'second' }])[0]);
    const element = cardIn(host, terminal.launchDirectory);
    (element ? bringForwardIn(element) : undefined)?.click();
    expect(pressed.map(current => (current.kind === 'disconnected' ? [] : current.activationTargets))).toEqual([[terminal.id, 'second']]);
  });

  it('shows each of two reasons with the same text, and keeps a selection in the first, across an update', () => {
    const terminal = withWork({ attention: { status: 'needs a human', reasons: ['Approve the plan', 'Approve the plan'] } });
    const { host, card } = mountRecording(terminal);
    const count = () => (cardIn(host, terminal.launchDirectory)?.textContent ?? '').split('Approve the plan').length - 1;
    const before = count();
    const element = cardIn(host, terminal.launchDirectory);
    const walker = element ? document.createTreeWalker(element, NodeFilter.SHOW_TEXT) : undefined;
    while (walker?.nextNode() && walker.currentNode.textContent !== 'Approve the plan');
    if (walker?.currentNode.parentNode) getSelection()?.selectAllChildren(walker.currentNode.parentNode);
    card.update(directoryCards([terminal])[0]);
    expect({ before, after: count(), selected: getSelection()?.toString() }).toEqual({ before: 2, after: 2, selected: 'Approve the plan' });
  });

  it('keeps focus on the same Dismiss of a loop message across an update', () => {
    const { terminal } = STATUS_CASES['loop-error'];
    const { host, card } = mountRecording(terminal);
    const element = cardIn(host, terminal.launchDirectory);
    const dismiss = element ? dismissLoopMessageIn(element) : undefined;
    dismiss?.focus();
    card.update(directoryCards([terminal])[0]);
    expect({ found: Boolean(dismiss), same: document.activeElement === dismiss }).toEqual({ found: true, same: true });
  });

  it('keeps a selection in a condition\'s title across an update', () => {
    const { terminal } = STATUS_CASES['loop-error'];
    const { host, card } = mountRecording(terminal);
    const element = cardIn(host, terminal.launchDirectory);
    const walker = element ? document.createTreeWalker(element, NodeFilter.SHOW_TEXT) : undefined;
    let title: Node | null = null;
    while (walker?.nextNode()) if (walker.currentNode.textContent === 'Loop error') title = walker.currentNode;
    if (title) getSelection()?.selectAllChildren(title.parentNode!);
    card.update(directoryCards([terminal])[0]);
    expect(getSelection()?.toString()).toBe('Loop error');
  });

  it('refuses an update to a different launch directory', () => {
    const { terminal } = STATUS_CASES.working;
    const { card } = mountRecording(terminal);
    expect(() => card.update(directoryCards([{ ...terminal, launchDirectory: '/elsewhere' }])[0])).toThrow(/elsewhere/);
  });

  it('offers Clear history only while its directory has a history it can clear', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const terminal = { ...statusTerminal(), timeline: [statusItem('Turned quiet', 1)] } as ControllerTerminal;
    const target = { id: terminal.id, launchDirectory: terminal.launchDirectory, revision: 'r1' };
    const cleared: string[] = [];
    const card = createControllerCard(host, {
      card: directoryCards([terminal])[0], expandedByDefault: true, timeText: TIME_TEXT,
      onAction() {}, onDismissLoopMessage() {}, onClearHistory(asked) { cleared.push(asked.revision); },
    });
    const element = () => cardIn(host, terminal.launchDirectory)!;
    const withoutTarget = clearHistoryIn(element()) !== undefined;
    card.update(directoryCards([{ ...terminal, clearHistoryTarget: target }])[0]);
    clearHistoryIn(element())?.click();
    expect({ withoutTarget, cleared }).toEqual({ withoutTarget: false, cleared: ['r1'] });
  });
});

describe('controller card identity', () => {
  const identity = { title: 'Reconcile the card identity', branch: 'feature/identity-slots' };
  const named = (terminal: ControllerTerminal, status: string) =>
    [terminal.repositoryRoot?.split('/').at(-1) ?? '', terminal.launchDirectory, `${status} · ${TIME_TEXT}`];

  it.each([true, false])('shows the repository name, title, branch and status in the header, in that order (expanded=%s)', expanded => {
    const terminal = withWork({ ...identity, activity: 'quiet' });
    const { element } = mount(terminal, expanded);
    const header = element ? cardHeaderTextIn(element) : '';
    expect(missingInOrder(header, ['repository', identity.title, identity.branch, `Idle · ${TIME_TEXT}`])).toEqual([]);
  });

  it.each([true, false])('shows neither a title slot nor a branch slot, and no placeholder, when the terminal has none (expanded=%s)', expanded => {
    const terminal = withWork({ title: null, branch: null, activity: 'quiet' });
    const { element } = mount(terminal, expanded);
    const header = element ? cardHeaderTextIn(element) : '';
    expect({
      leftover: headerRemainder(header, named(terminal, 'Idle')),
      name: header.includes('repository'),
      status: header.includes(`Idle · ${TIME_TEXT}`),
    }).toEqual({ leftover: '', name: true, status: true });
  });

  it.each([true, false])('shows the name, status and time in state alone for a terminal that does not report title or branch (expanded=%s)', expanded => {
    const terminal = withWork({ activity: 'quiet' });
    const { element } = mount(terminal, expanded);
    const header = element ? cardHeaderTextIn(element) : '';
    expect({
      leftover: headerRemainder(header, named(terminal, 'Idle')),
      name: header.includes('repository'),
      status: header.includes(`Idle · ${TIME_TEXT}`),
    }).toEqual({ leftover: '', name: true, status: true });
  });

  it('keeps each slot independent: a title with no branch, and a branch with no title', () => {
    const titleOnly = withWork({ title: identity.title, branch: null, activity: 'quiet' });
    const branchOnly = { ...withWork({ title: null, branch: identity.branch, activity: 'quiet' }), id: 'terminal-b', launchDirectory: '/fixed/other-worktree' };
    const first = mount(titleOnly, false);
    const second = mount(branchOnly, false);
    const firstHeader = first.element ? cardHeaderTextIn(first.element) : '';
    const secondHeader = second.element ? cardHeaderTextIn(second.element) : '';
    expect({
      titleOnly: [firstHeader.includes(identity.title), firstHeader.includes(identity.branch), headerRemainder(firstHeader, [...named(titleOnly, 'Idle'), identity.title])],
      branchOnly: [secondHeader.includes(identity.title), secondHeader.includes(identity.branch), headerRemainder(secondHeader, [...named(branchOnly, 'Idle'), identity.branch])],
    }).toEqual({ titleOnly: [true, false, ''], branchOnly: [false, true, ''] });
  });

  it('shows a title that holds markup characters as plain text', () => {
    const title = '<b>bold</b> & "quoted"';
    const { element } = mount(withWork({ title, branch: 'a<b' }));
    expect({ text: element ? cardHeaderTextIn(element).includes(title) : false, injected: element?.querySelector('header b') ?? null }).toEqual({ text: true, injected: null });
  });
});

describe('controller card timeline', () => {
  const at = (hour: number, minute: number) => new Date(2026, 9, 28, hour, minute).getTime();
  const timeline = [
    statusItem('Turned quiet at the newest moment', at(15, 43)),
    notificationItem('Review the release proposal', at(13, 24), 2),
    statusItem('Started the oldest retained change', at(10, 17)),
  ];
  const withTimeline = (items: readonly unknown[], work: Partial<WorkStatus> = {}) => {
    const terminal = statusTerminal(work);
    return { ...terminal, timeline: items, clearHistoryTarget: { id: terminal.id, launchDirectory: terminal.launchDirectory, revision: 'r1' } } as ControllerTerminal;
  };
  function mountWithClear(terminal: ControllerTerminal) {
    const host = document.createElement('div');
    document.body.append(host);
    let cleared = 0;
    const card = createControllerCard(host, {
      card: directoryCards([terminal])[0], expandedByDefault: true, timeText: TIME_TEXT,
      onAction() {}, onDismissLoopMessage() {}, onClearHistory() { cleared += 1; },
    });
    return { card, element: cardIn(host, terminal.launchDirectory)!, cleared: () => cleared };
  }

  it('shows every entry newest first, each with its time, and no History control', () => {
    const { element } = mountWithClear(withTimeline(timeline));
    const entries = timelineEntriesIn(element);
    expect.soft(entries).toHaveLength(3);
    expect.soft(missingInOrder(element.textContent ?? '', ['Turned quiet at the newest moment', 'Review the release proposal', 'Started the oldest retained change'])).toEqual([]);
    expect.soft(entries.map(entry => entryTimesIn(entry).length)).toEqual([1, 1, 1]);
    const clocks = [/\b(?:15|3):43\b/, /\b(?:13|1):24\b/, /\b10:17\b/];
    clocks.forEach((clock, index) => expect.soft(entries[index]?.textContent ?? '').toMatch(clock));
    expect.soft(historyIn(element)).toBeUndefined();
  });

  it('identifies a notification entry to assistive technology and does not label a status entry as one', () => {
    const { element } = mountWithClear(withTimeline(timeline));
    const [newestStatus, notification, oldestStatus] = timelineEntriesIn(element);
    expect.soft(entryAccessibleText(notification ?? element)).toContain('Review the release proposal');
    expect.soft(notification && entryIsNotification(notification)).toBe(true);
    expect.soft(entryAccessibleText(newestStatus ?? element)).toContain('Turned quiet at the newest moment');
    expect.soft(newestStatus && entryIsNotification(newestStatus)).toBe(false);
    expect.soft(oldestStatus && entryIsNotification(oldestStatus)).toBe(false);
  });

  it('shows how many times a notification arrived only when more than once', () => {
    const { element } = mountWithClear(withTimeline([notificationItem('Seen once', at(9, 5)), notificationItem('Seen twelve times', at(8, 5), 12)]));
    const [once, many] = timelineEntriesIn(element);
    expect.soft(many?.textContent ?? '').toMatch(/12\s*(?:arrivals|times|×)|(?:×|received)\s*12/i);
    expect.soft(once?.textContent ?? '').not.toMatch(/\b1\s*(?:arrivals|times|×)|(?:×|received)\s*1\b/i);
  });

  it('shows Clear history whenever the timeline has entries, status entries alone included, and reports its use once', () => {
    const { element, cleared } = mountWithClear(withTimeline([statusItem('Turned quiet', at(9, 5))]));
    const clear = clearHistoryIn(element);
    expect.soft(clear).toBeDefined();
    clear?.click();
    expect.soft(cleared()).toBe(1);
  });

  it('shows no entries and no Clear history when the timeline is empty or absent', () => {
    for (const items of [[], undefined]) {
      const terminal = items ? withTimeline(items) : statusTerminal();
      const { element, card } = mountWithClear(terminal);
      expect.soft(timelineEntriesIn(element)).toEqual([]);
      expect.soft(clearHistoryIn(element)).toBeUndefined();
      card.dispose();
    }
  });

  it('shows terminal-supplied entry text as plain text', () => {
    const { element } = mountWithClear(withTimeline([statusItem('<img src=x onerror=alert(1)> became idle', at(9, 5)), notificationItem('<b>approve</b>', at(8, 5))]));
    expect.soft(element.querySelector('img')).toBeNull();
    expect.soft(element.querySelector('b')).toBeNull();
    expect.soft(timelineEntriesIn(element)[0]?.textContent).toContain('<img src=x onerror=alert(1)> became idle');
    expect.soft(timelineEntriesIn(element)[1]?.textContent).toContain('<b>approve</b>');
  });

  it('shows no timeline on a card for terminals that conflict', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const [a, b] = [withTimeline(timeline), { ...withTimeline(timeline), id: 'peer' }];
    const component = createControllerCard(host, { card: directoryCards([a, b])[0], expandedByDefault: true, timeText: TIME_TEXT, onAction() {}, onDismissLoopMessage() {} });
    try {
      expect(timelineEntriesIn(cardIn(host, a.launchDirectory)!)).toEqual([]);
    } finally { component.dispose(); }
  });
});
